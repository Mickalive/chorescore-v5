import { LocalNotificationAdapter, todoNotificationId } from '../src/infrastructure/local/LocalNotificationAdapter';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 }, SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationChannelAsync: jest.fn().mockResolvedValue(null),
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn().mockImplementation(async options => options.identifier),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(null), setNotificationHandler: jest.fn(),
}));
const originalOS = Platform.OS;
beforeEach(() => { Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true }); jest.clearAllMocks(); });
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
