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
