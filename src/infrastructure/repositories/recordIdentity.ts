import { randomUUID } from 'expo-crypto';

/** Independent devices and app restarts must never share a clock/counter id. */
export function generateRecordId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
