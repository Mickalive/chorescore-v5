/** Native, on-device reminders. No remote push service is required. */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NotificationGateway, NotificationOptions } from '../../application/ports';

const CHANNEL = 'chorescore-reminders';
const ENABLED_KEY = 'chorescore.reminders.enabled.v1';
const RECONCILIATION_ERROR_KEY = 'chorescore.reminders.reconcileError.v1';

export class RemindersDisabledError extends Error {
  constructor() { super('Reminders disabled'); this.name = 'RemindersDisabledError'; }
}
export function todoNotificationId(todoId: string): string {
  return `chorescore-todo:${todoId}`;
}

export class LocalNotificationAdapter implements NotificationGateway {
  constructor(private readonly getActiveUserId?: () => string | null) {}
  private pending: Promise<unknown> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async getEnabled(): Promise<boolean> {
    return (await AsyncStorage.getItem(ENABLED_KEY)) !== 'false';
  }

  async getReconciliationError(): Promise<boolean> {
    return (await AsyncStorage.getItem(RECONCILIATION_ERROR_KEY)) === 'true';
  }

  /** Read the current SQLite view only after earlier native work is finished.
   * Used after restart/sync, with no permission popup and no remote push service.
   */
  reconcile(getReminders: () => Promise<NotificationOptions[]>): Promise<void> {
    return this.serialize(async () => {
      if (!this.isAvailable()) return;
      try {
        const enabled = await this.getEnabled();
        const desired = new Map<string, NotificationOptions>();
        if (enabled) {
          for (const reminder of await getReminders()) {
            const todoId = reminder.data?.todoId;
            if (typeof todoId !== 'string' || !reminder.scheduledAt || Date.parse(reminder.scheduledAt) <= Date.now()
                || !Number.isFinite(Date.parse(reminder.scheduledAt))) continue;
            desired.set(todoNotificationId(todoId), reminder);
          }
        }
        const scheduled = await Notifications.getAllScheduledNotificationsAsync();
        const existing = new Map(scheduled.map(request => [request.identifier, request]));
        const cancelled = await Promise.allSettled(scheduled
          .filter(request => request.identifier.startsWith('chorescore-todo:') && !desired.has(request.identifier))
          .map(request => Notifications.cancelScheduledNotificationAsync(request.identifier)));
        let failed = cancelled.some(result => result.status === 'rejected');
        for (const [id, reminder] of desired) {
          const current = existing.get(id);
          if (current?.content?.title === reminder.title && current.content.body === reminder.body
              && current.content.data?.chorescoreReminderAt === reminder.scheduledAt
              && current.content.data?.userId === reminder.data?.userId
              && current.content.data?.householdId === reminder.data?.householdId) continue;
          try { await this.scheduleNative(reminder, false); } catch { failed = true; }
        }
        if (failed) throw new Error('Some native reminders could not be reconciled');
        await AsyncStorage.removeItem(RECONCILIATION_ERROR_KEY);
      } catch (error) {
        await AsyncStorage.setItem(RECONCILIATION_ERROR_KEY, 'true').catch(() => undefined);
        throw error;
      }
    });
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
        await AsyncStorage.removeItem(RECONCILIATION_ERROR_KEY);
        return;
      }
      if (!(await this.requestPermission())) throw new Error('Notification permission denied');
      const desiredIds = new Set(reminders.filter(reminder => reminder.scheduledAt && Date.parse(reminder.scheduledAt) > Date.now())
        .map(reminder => typeof reminder.data?.todoId === 'string' ? todoNotificationId(reminder.data.todoId) : null));
      const obsolete = (await Notifications.getAllScheduledNotificationsAsync())
        .filter(request => request.identifier.startsWith('chorescore-todo:') && !desiredIds.has(request.identifier));
      const cancelled = await Promise.allSettled(obsolete.map(request => Notifications.cancelScheduledNotificationAsync(request.identifier)));
      if (cancelled.some(result => result.status === 'rejected')) throw new Error('Some native reminders could not be cancelled');
      const restored: string[] = [];
      try {
        for (const reminder of reminders) {
          if (reminder.scheduledAt && Date.parse(reminder.scheduledAt) > Date.now()) {
            restored.push(await this.scheduleNative(reminder));
          }
        }
        await AsyncStorage.setItem(ENABLED_KEY, 'true');
        await AsyncStorage.removeItem(RECONCILIATION_ERROR_KEY);
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
      handleNotification: async notification => {
        const enabled = await this.getEnabled().catch(() => false);
        const owner = notification?.request?.content?.data?.userId;
        const allowed = enabled && (!this.getActiveUserId ||
          (typeof owner === 'string' && owner === this.getActiveUserId()));
        return { shouldShowBanner: allowed, shouldShowList: allowed,
          shouldPlaySound: allowed, shouldSetBadge: false };
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

  private async scheduleNative(options: NotificationOptions, promptForPermission = true): Promise<string> {
    const userId = this.getActiveUserId?.();
    if (this.getActiveUserId && (!userId || (options.data?.userId && options.data.userId !== userId))) {
      throw new Error('Reminder does not belong to the active account');
    }
    const date = options.scheduledAt ? new Date(options.scheduledAt) : null;
    if (date && (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())) {
      throw new Error('Reminder must be scheduled in the future');
    }
    const granted = promptForPermission ? await this.requestPermission() : (await Notifications.getPermissionsAsync()).granted;
    if (!granted) throw new Error('Notification permission denied');
    if (!promptForPermission && Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'ChoreScore', importance: Notifications.AndroidImportance.HIGH, sound: 'default' });
    }
    if (this.getActiveUserId && this.getActiveUserId() !== userId) throw new Error('Account changed while scheduling reminder');
    this.initialize();
    const todoId = options.data?.todoId;
    return Notifications.scheduleNotificationAsync({
      ...(typeof todoId === 'string' ? { identifier: todoNotificationId(todoId) } : {}),
      content: { title: options.title, body: options.body, data: { ...options.data, ...(userId ? { userId } : {}), chorescoreReminderAt: options.scheduledAt ?? null }, sound: 'default' },
      trigger: date ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: CHANNEL } : null,
    });
  }

  cancelNotification(id: string): Promise<void> {
    return this.serialize(async () => {
      if (this.isAvailable()) await Notifications.cancelScheduledNotificationAsync(id);
    });
  }
}
