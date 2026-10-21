/**
 * Native text/link share sheet for ChoreScore V5.
 * React Native Share.share handles messages/URLs; expo-sharing is only
 * for real local files. Passing HTTPS URLs into expo-sharing was broken.
 */
import { Share } from 'react-native';
import * as Sharing from 'expo-sharing';
import { SystemShareGateway, ShareOptions, ShareResult } from '../../application/ports';

export class LocalSystemShareAdapter implements SystemShareGateway {
  isAvailable(): boolean {
    return true;
  }

  async share(options: ShareOptions): Promise<ShareResult> {
    try {
      if (options.files && options.files.length > 0) {
        // Never silently omit additional files or claim unsupported sharing succeeded.
        if (options.files.length !== 1 || !await Sharing.isAvailableAsync()) {
          return { completed: false };
        }
        await Sharing.shareAsync(options.files[0], { dialogTitle: options.title });
        return { completed: true, method: 'native-file-share' };
      }
      const message = [
        options.message,
        options.url && !options.message?.includes(options.url) ? options.url : undefined,
      ].filter(Boolean).join('\n');
      if (!message) return { completed: false };
      const result = await Share.share({ title: options.title, message });
      return {
        completed: result.action === Share.sharedAction,
        method: 'native-share',
      };
    } catch {
      return { completed: false };
    }
  }
}
