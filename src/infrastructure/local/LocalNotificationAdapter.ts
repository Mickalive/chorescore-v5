/** Native, on-device reminders. No remote push service is required. */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NotificationGateway, NotificationOptions } from '../../application/ports';

const CHANNEL = 'chorescore-reminders';
const ENABLED_KEY = 'chorescore.reminders.enabled.v1';

export class RemindersDisabledError extends Error {
  constructor() { super('Reminders disabled'); this.name = 'RemindersDisabledError'; }
}
export function todoNotificationId(todoId: string): string {
  return `chorescore-todo:${todoId}`;
}

export class LocalNotificationAdapter implements NotificationGateway {
  private pending: Promise<unknown> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async getEnabled(): Promise<boolean> {
    return (await AsyncStorage.getItem(ENABLED_KEY)) !== 'false';
  }

  /** Disabling cancels native requests; enabling restores future pending todos. */
  setEnabled(enabled: boolean, reminders: NotificationOptions[] = []): Promise<void> {
    return this.serialize(async () => {
      if (!enabled) {
        // Persist first so no later scheduling call can undo a user's opt-out.
        await AsyncStorage.setItem(ENABLED_KEY, 'false');
        if (this.isAvailable()) {
          const scheduled = await Notifications.getAllScheduledNotificationsAsync();
          const results = await Promise.allSettled(scheduled
            .filter(item => item.identifier.startsWith('chorescore-todo:'))
            .map(item => Notifications.cancelScheduledNotificationAsync(item.identifier)));
          if (results.some(result => result.status === 'rejected')) {
            throw new Error('Some native reminders could not be cancelled');
          }
        }
        return;
      }
      if (!(await this.requestPermission())) throw new Error('Notification permission denied');
      const restored: string[] = [];
      try {
        for (const reminder of reminders) {
          if (reminder.scheduledAt && Date.parse(reminder.scheduledAt) > Date.now()) {
            restored.push(await this.scheduleNative(reminder));
          }
        }
        await AsyncStorage.setItem(ENABLED_KEY, 'true');
      } catch (error) {
        await Promise.allSettled(restored.map(id => Notifications.cancelScheduledNotificationAsync(id)));
        throw error;
      }
    });
  }
  isAvailable(): boolean {
    return Platform.OS === 'android' || Platform.OS === 'ios';
  }

  initialize(): void {
    if (!this.isAvailable()) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => {
        const enabled = await this.getEnabled().catch(() => false);
        return { shouldShowBanner: enabled, shouldShowList: enabled,
          shouldPlaySound: enabled, shouldSetBadge: false };
      },
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

  scheduleNotification(options: NotificationOptions): Promise<string> {
    return this.serialize(async () => {
      if (!(await this.getEnabled())) throw new RemindersDisabledError();
      return this.scheduleNative(options);
    });
  }

  private async scheduleNative(options: NotificationOptions): Promise<string> {
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

  cancelNotification(id: string): Promise<void> {
    return this.serialize(async () => {
      if (this.isAvailable()) await Notifications.cancelScheduledNotificationAsync(id);
    });
  }
}
