import { LocalNotificationAdapter, todoNotificationId } from '../src/infrastructure/local/LocalNotificationAdapter';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 }, SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationChannelAsync: jest.fn().mockResolvedValue(null),
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn().mockImplementation(async options => options.identifier),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(null), setNotificationHandler: jest.fn(),
  getAllScheduledNotificationsAsync: jest.fn().mockResolvedValue([]),
}));
const originalOS = Platform.OS;
beforeEach(async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.clearAllMocks();
  await AsyncStorage.clear();
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([]);
});
afterAll(() => { Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true }); });

test('native reminder creates Android channel before permission and uses stable todo identity', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  const adapter = new LocalNotificationAdapter();
  const date = new Date(Date.now()+3600000).toISOString();
  expect(await adapter.scheduleNotification({ title:'Courses',body:'Pain',scheduledAt:date,data:{todoId:'t'} })).toBe(todoNotificationId('t'));
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
    identifier: todoNotificationId('t'), trigger: expect.objectContaining({type:'date',date:new Date(date)}),
  }));
  expect(jest.mocked(Notifications.setNotificationChannelAsync).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(Notifications.getPermissionsAsync).mock.invocationCallOrder[0]);
  await adapter.cancelNotification(todoNotificationId('t'));
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('t'));
});
test('permission denial is an error, never a fake reminder identifier', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted:false } as any);
  jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted:false } as any);
  await expect(new LocalNotificationAdapter().scheduleNotification({title:'T',body:'B'})).rejects.toThrow('permission denied');
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});
test.each(['invalid','2000-01-01T00:00:00Z'])('invalid or past reminder never reaches the native scheduler: %s', scheduledAt => {
  return expect(new LocalNotificationAdapter().scheduleNotification({title:'T',body:'B',scheduledAt})).rejects.toThrow('future');
});

test('opt-out survives adapter restart, cancels only ChoreScore todos and prevents new reminders', async () => {
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([
    { identifier: todoNotificationId('a') }, { identifier: 'another-feature' },
  ] as any);
  const adapter = new LocalNotificationAdapter();
  await adapter.setEnabled(false);
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('a'));
  const restarted = new LocalNotificationAdapter();
  expect(await restarted.getEnabled()).toBe(false);
  await expect(restarted.scheduleNotification({ title: 'T', body: 'B' })).rejects.toThrow('disabled');
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});

test('enabling restores only future reminders with the same todo identity', async () => {
  const adapter = new LocalNotificationAdapter();
  await adapter.setEnabled(false);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  await adapter.setEnabled(true, [
    { title: 'Future', body: 'B', data: { todoId: 'a' }, scheduledAt: new Date(Date.now() + 3600000).toISOString() },
    { title: 'Past', body: 'B', data: { todoId: 'b' }, scheduledAt: '2000-01-01T00:00:00Z' },
  ]);
  expect(await new LocalNotificationAdapter().getEnabled()).toBe(true);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({ identifier: todoNotificationId('a') }));
});

test('permission denial does not override the persisted opt-out', async () => {
  const adapter = new LocalNotificationAdapter();
  await adapter.setEnabled(false);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as any);
  jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted: false } as any);
  await expect(adapter.setEnabled(true)).rejects.toThrow('permission denied');
  expect(await adapter.getEnabled()).toBe(false);
});

test('a partial restore failure cancels restored reminders and keeps the opt-out', async () => {
  const adapter = new LocalNotificationAdapter();
  await adapter.setEnabled(false);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  jest.mocked(Notifications.scheduleNotificationAsync)
    .mockResolvedValueOnce(todoNotificationId('a'))
    .mockRejectedValueOnce(new Error('native scheduler failed'));
  const scheduledAt = new Date(Date.now() + 3600000).toISOString();
  await expect(adapter.setEnabled(true, ['a', 'b'].map(todoId => ({
    title: todoId, body: 'B', scheduledAt, data: { todoId },
  })))).rejects.toThrow('native scheduler failed');
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('a'));
  expect(await adapter.getEnabled()).toBe(false);
});

test('a cancellation failure still attempts every reminder and allows a safe retry while disabled', async () => {
  const adapter = new LocalNotificationAdapter();
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([
    { identifier: todoNotificationId('a') }, { identifier: todoNotificationId('b') },
  ] as any);
  jest.mocked(Notifications.cancelScheduledNotificationAsync).mockRejectedValueOnce(new Error('native failure'));
  await expect(adapter.setEnabled(false)).rejects.toThrow('could not be cancelled');
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('b'));
  expect(await adapter.getEnabled()).toBe(false);
  await expect(adapter.setEnabled(false)).resolves.toBeUndefined();
});

test('foreground notification presentation honors the persisted opt-out', async () => {
  const adapter = new LocalNotificationAdapter();
  await adapter.setEnabled(false);
  adapter.initialize();
  const handler = jest.mocked(Notifications.setNotificationHandler).mock.calls.at(-1)![0]!;
  expect(await handler.handleNotification({} as any)).toMatchObject({
    shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false,
  });
});

test('opt-out waits for an in-flight scheduler then cancels it, never leaving a late reminder', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  let finish!: (value: string) => void;
  jest.mocked(Notifications.scheduleNotificationAsync).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const adapter = new LocalNotificationAdapter();
  const scheduled = adapter.scheduleNotification({ title: 'T', body: 'B', data: { todoId: 'late' } });
  const disabled = adapter.setEnabled(false);
  // Let storage and permission promises settle until the native call is pending.
  for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
  expect(finish).toBeDefined();
  expect(Notifications.getAllScheduledNotificationsAsync).not.toHaveBeenCalled();
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([{ identifier: todoNotificationId('late') }] as any);
  finish(todoNotificationId('late'));
  await Promise.all([scheduled, disabled]);
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('late'));
  expect(await adapter.getEnabled()).toBe(false);
});

test('a received reminder is scheduled once; a remote completion cancels it without prompting', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  const adapter = new LocalNotificationAdapter();
  const desired = { title: 'Rappel reçu', body: 'Courses', scheduledAt: new Date(Date.now() + 3600000).toISOString(), data: { todoId: 'remote' } };
  await adapter.reconcile(async () => [desired]);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  const request = jest.mocked(Notifications.scheduleNotificationAsync).mock.calls.at(-1)![0];
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([{ ...request, identifier: todoNotificationId('remote') }] as any);
  await adapter.reconcile(async () => [desired]);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  await adapter.reconcile(async () => []);
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('remote'));
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('background reconciliation respects opt-out and never requests permission', async () => {
  const adapter = new LocalNotificationAdapter();
  await AsyncStorage.setItem('chorescore.reminders.enabled.v1', 'false');
  const source = jest.fn().mockResolvedValue([]);
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([
    { identifier: todoNotificationId('old') }, { identifier: 'other-feature' },
  ] as any);
  await adapter.reconcile(source);
  expect(source).not.toHaveBeenCalled();
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('old'));
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('reconciliation reports cancellation failures but still attempts every stale reminder', async () => {
  const adapter = new LocalNotificationAdapter();
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([
    { identifier: todoNotificationId('a') }, { identifier: todoNotificationId('b') },
  ] as any);
  jest.mocked(Notifications.cancelScheduledNotificationAsync).mockRejectedValueOnce(new Error('native cancellation failed'));
  await expect(adapter.reconcile(async () => [])).rejects.toThrow();
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('b'));
  expect(await adapter.getReconciliationError()).toBe(true);
  await adapter.reconcile(async () => []);
  expect(await adapter.getReconciliationError()).toBe(false);
});

test('the desired reminders are read inside the queue after an in-flight scheduling operation', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  const adapter = new LocalNotificationAdapter();
  let release!: (id: string) => void;
  jest.mocked(Notifications.scheduleNotificationAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const desired = { title: 'Future', body: '', scheduledAt: new Date(Date.now() + 3600000).toISOString(), data: { todoId: 'queued' } };
  const scheduled = adapter.scheduleNotification(desired);
  const source = jest.fn().mockResolvedValue([desired]);
  const reconciled = adapter.reconcile(source);
  for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
  expect(source).not.toHaveBeenCalled();
  const request = jest.mocked(Notifications.scheduleNotificationAsync).mock.calls.at(-1)![0];
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([{ ...request, identifier: todoNotificationId('queued') }] as any);
  release(todoNotificationId('queued'));
  await Promise.all([scheduled, reconciled]);
  expect(source).toHaveBeenCalledTimes(1);
  expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
});


test('background reconciliation never prompts after permission is denied and a later retry repairs it', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as any);
  const adapter = new LocalNotificationAdapter();
  const source = async () => [{ title: 'Received', body: '', scheduledAt: new Date(Date.now() + 3600000).toISOString(), data: { todoId: 'denied' } }];
  await expect(adapter.reconcile(source)).rejects.toThrow();
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(await adapter.getReconciliationError()).toBe(true);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  await adapter.reconcile(source);
  expect(await adapter.getReconciliationError()).toBe(false);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
});

test('explicit repair removes obsolete reminders before restoring pending ones', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  jest.mocked(Notifications.getAllScheduledNotificationsAsync).mockResolvedValue([
    { identifier: todoNotificationId('completed') }, { identifier: 'other-feature' },
  ] as any);
  const adapter = new LocalNotificationAdapter();
  await adapter.setEnabled(true, [{ title: 'Pending', body: '', scheduledAt: new Date(Date.now() + 3600000).toISOString(), data: { todoId: 'pending' } }]);
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(todoNotificationId('completed'));
  expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith('other-feature');
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
});


test('foreground reminders are hidden after signout or switching accounts', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as any);
  let user: string | null = 'alice';
  const adapter = new LocalNotificationAdapter(() => user);
  await adapter.scheduleNotification({ title: 'Private task', body: '', scheduledAt: new Date(Date.now() + 3600000).toISOString(), data: { todoId: 'private' } });
  const request = jest.mocked(Notifications.scheduleNotificationAsync).mock.calls.at(-1)![0];
  expect(request.content.data).toMatchObject({ userId: 'alice' });
  const handler = jest.mocked(Notifications.setNotificationHandler).mock.calls.at(-1)![0]!;
  expect(await handler.handleNotification({ request } as any)).toMatchObject({ shouldShowBanner: true });
  user = null;
  expect(await handler.handleNotification({ request } as any)).toMatchObject({ shouldShowBanner: false, shouldShowList: false });
  user = 'bob';
  expect(await handler.handleNotification({ request } as any)).toMatchObject({ shouldShowBanner: false });
});

test('a permission response arriving after an account switch cannot schedule the old account reminder', async () => {
  let resolvePermission!: (value: any) => void;
  jest.mocked(Notifications.getPermissionsAsync).mockImplementationOnce(() => new Promise(resolve => { resolvePermission = resolve; }));
  let user: string | null = 'alice';
  const adapter = new LocalNotificationAdapter(() => user);
  const scheduled = adapter.scheduleNotification({ title: 'Private', body: '', scheduledAt: new Date(Date.now() + 3600000).toISOString(), data: { todoId: 'changed' } });
  for (let i = 0; i < 20 && !resolvePermission; i++) await Promise.resolve();
  expect(resolvePermission).toBeDefined();
  user = 'bob';
  resolvePermission({ granted: true });
  await expect(scheduled).rejects.toThrow('Account changed');
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});

test('restoring reminders rejects another account before cancelling or scheduling any native request', async () => {
  const adapter = new LocalNotificationAdapter(() => 'new-account');
  await expect(adapter.setEnabled(true,[{title:'Old private task',body:'Old private note',scheduledAt:new Date(Date.now()+3600000).toISOString(),
    data:{todoId:'old-todo',householdId:'old-group',userId:'old-account'}}])).rejects.toThrow('Account changed');
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});

test('an account change during the restore permission prompt cannot reassign private reminders', async () => {
  let uid='old-account';
  const adapter = new LocalNotificationAdapter(() => uid);
  jest.mocked(Notifications.getPermissionsAsync).mockImplementationOnce(async()=>{ uid='new-account';return {granted:true} as any; });
  await expect(adapter.setEnabled(true,[{title:'Old private task',body:'Private',scheduledAt:new Date(Date.now()+3600000).toISOString(),
    data:{todoId:'old-todo',householdId:'old-group',userId:'old-account'}}])).rejects.toThrow('Account changed');
  expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});
