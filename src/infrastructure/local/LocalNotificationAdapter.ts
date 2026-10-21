/** Native, on-device reminders. No remote push service is required. */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { NotificationGateway, NotificationOptions } from '../../application/ports';

const CHANNEL = 'chorescore-reminders';
export function todoNotificationId(todoId: string): string {
  return `chorescore-todo:${todoId}`;
}

export class LocalNotificationAdapter implements NotificationGateway {
  isAvailable(): boolean {
    return Platform.OS === 'android' || Platform.OS === 'ios';
  }

  initialize(): void {
    if (!this.isAvailable()) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true,
        shouldPlaySound: true, shouldSetBadge: false }),
    });
  }

  async requestPermission(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    if (Platform.OS === 'android') {
      // Android 13 must have a channel before requesting notification permission.
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'ChoreScore', importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    return (await Notifications.requestPermissionsAsync()).granted;
  }

  async scheduleNotification(options: NotificationOptions): Promise<string> {
    const date = options.scheduledAt ? new Date(options.scheduledAt) : null;
    if (date && (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())) {
      throw new Error('Reminder must be scheduled in the future');
    }
    if (!(await this.requestPermission())) throw new Error('Notification permission denied');
    this.initialize();
    const todoId = options.data?.todoId;
    return Notifications.scheduleNotificationAsync({
      ...(typeof todoId === 'string' ? { identifier: todoNotificationId(todoId) } : {}),
      content: { title: options.title, body: options.body, data: options.data, sound: 'default' },
      trigger: date ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: CHANNEL } : null,
    });
  }

  async cancelNotification(id: string): Promise<void> {
    if (this.isAvailable()) await Notifications.cancelScheduledNotificationAsync(id);
  }
}
