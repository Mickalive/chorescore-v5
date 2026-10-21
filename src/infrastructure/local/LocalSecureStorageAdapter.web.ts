/** Web can retain an offline identity for development. Cloud credentials must
 * never silently fall back to unencrypted browser storage. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SecureStorageGateway } from '../../application/ports';
const LOCAL_ID = 'chorescore.auth.local-identity';
const LOCAL_SESSION = 'chorescore.auth.session';
export class LocalSecureStorageAdapter implements SecureStorageGateway {
  async setItem(key: string, value: string): Promise<void> {
    if (key === LOCAL_ID) { await AsyncStorage.setItem(key, value); return; }
    if (key === LOCAL_SESSION && JSON.parse(value).provider === 'local') {
      await AsyncStorage.setItem(key, value); return;
    }
    throw new Error('Secure credential storage is unavailable on web');
  }
  async getItem(key: string): Promise<string | null> {
    return key === LOCAL_ID || key === LOCAL_SESSION ? AsyncStorage.getItem(key) : null;
  }
  async deleteItem(key: string): Promise<void> { await AsyncStorage.removeItem(key); }
  async clear(): Promise<void> { await AsyncStorage.multiRemove([LOCAL_ID, LOCAL_SESSION]); }
}
