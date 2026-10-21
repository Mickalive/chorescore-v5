/**
 * Durable local photo attachments for ChoreScore V5.
 * Uses Expo FileSystem's OS file picker: no extra native dependency or
 * unconfigured provider is required. This does NOT sync photos to other phones.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { AttachmentGateway, AttachmentHandle, AttachmentSource } from '../../application/ports';

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const ROOT = 'chorescore-photos';

function photoDirectory(householdId: string): Directory {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(householdId)) {
    throw new Error('Invalid photo household ID');
  }
  return new Directory(Paths.document, ROOT, householdId);
}

function extension(mimeType?: string): string {
  switch (mimeType) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    default: return 'jpg';
  }
}

export class LocalAttachmentAdapter implements AttachmentGateway {
  isAvailable(): boolean {
    return true;
  }

  async pickPhoto(): Promise<AttachmentSource | null> {
    const selection = await File.pickFileAsync({ mimeTypes: ['image/*'] });
    if (selection.canceled) return null;
    const selected = selection.result;
    if (selected.type && !selected.type.startsWith('image/')) {
      throw new Error('Selected file is not an image');
    }
    if (selected.size > MAX_PHOTO_BYTES) {
      throw new Error('Photo exceeds 20 MB');
    }
    return {
      localUri: selected.uri,
      mimeType: selected.type || 'image/jpeg',
      byteSize: selected.size,
    };
  }

  async save(source: AttachmentSource, householdId: string): Promise<AttachmentHandle> {
    if (!/^(file|content):\/\//.test(source.localUri)) throw new Error('Invalid photo URI');
    if (source.byteSize !== undefined && source.byteSize > MAX_PHOTO_BYTES) {
      throw new Error('Photo exceeds 20 MB');
    }
    const folder = photoDirectory(householdId);
    folder.create({ idempotent: true, intermediates: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    const destination = new File(folder, `${id}.${extension(source.mimeType)}`);
    await new File(source.localUri).copy(destination);
    if (!destination.exists || destination.size <= 0 || destination.size > MAX_PHOTO_BYTES) {
      if (destination.exists) await destination.delete();
      throw new Error('Photo could not be stored');
    }
    return {
      ref: destination.uri,
      mimeType: source.mimeType,
      byteSize: destination.size,
      width: source.width,
      height: source.height,
    };
  }

  async remove(handle: AttachmentHandle): Promise<void> {
    // Never delete arbitrary source files: only our application's managed photos.
    const safePrefix = new Directory(Paths.document, ROOT).uri.replace(/\/$/, '') + '/';
    if (!handle.ref.startsWith(safePrefix)) throw new Error('Refusing external photo deletion');
    const file = new File(handle.ref);
    if (file.exists) await file.delete();
  }
}
