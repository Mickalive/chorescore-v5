/**
 * Private photos on Firebase Spark, without Cloud Storage.
 *
 * Cloud Storage for Firebase now requires the paid Blaze plan, so this adapter
 * stores a compressed photo as a base64 field in a Firestore document. The
 * bound is deliberately below Firestore's 1 MiB document limit (700 KiB of
 * binary data, ~956 KiB once base64-encoded, plus small metadata). Normal
 * camera photos are resized/compressed with expo-image-manipulator first; an
 * oversized photo fails honestly instead of producing a corrupt document.
 *
 * Firestore rules restrict every media document to members of its group.
 */
import { MediaGateway } from '../../application/ports';
import { FirestoreDocument, FirestorePort, FirestoreTransaction } from './FirestorePort';
import { FirestoreRestClient } from './FirestoreRestClient';

export const MAX_FIRESTORE_MEDIA_BYTES = 700 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
};

export class FirebaseMediaError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'FirebaseMediaError';
  }
}

async function readLocalFile(uri: string): Promise<Uint8Array> {
  const { File } = await import('expo-file-system');
  const file = new File(uri);
  if (!file.exists) throw new Error('Photo locale introuvable');
  return new Uint8Array(await file.bytes());
}

async function cachedFile(householdId: string, remoteRef: string): Promise<string | null> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.cache, 'chorescore-media', householdId);
  if (!directory.exists) return null;
  for (const extension of Object.values(EXTENSIONS)) {
    const file = new File(directory, `${remoteRef}.${extension}`);
    if (file.exists && file.size > 0) return file.uri;
  }
  return null;
}

async function writeCachedFile(
  householdId: string,
  remoteRef: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.cache, 'chorescore-media', householdId);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${remoteRef}.${EXTENSIONS[mimeType] ?? 'jpg'}`);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file.uri;
}

async function compressPhoto(uri: string): Promise<{ uri: string; mimeType: string }> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(uri);
  context.resize({ width: 1280 });
  const image = await context.renderAsync();
  const result = await image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
  return { uri: result.uri, mimeType: 'image/jpeg' };
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) {
      output += '==';
      break;
    }
    output += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) {
      output += '=';
      break;
    }
    output += alphabet[third & 0x3f];
  }
  return output;
}

function fromBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value.replace(/=+$/, '')) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  const Crypto = await import('expo-crypto');
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isImage(bytes: Uint8Array): boolean {
  const signature = bytes.subarray(0, 12);
  return (
    (signature[0] === 0xff && signature[1] === 0xd8) ||
    (signature[0] === 0x89 &&
      signature[1] === 0x50 &&
      signature[2] === 0x4e &&
      signature[3] === 0x47 &&
      signature[4] === 0x0d &&
      signature[5] === 0x0a &&
      signature[6] === 0x1a &&
      signature[7] === 0x0a) ||
    String.fromCharCode(...signature.subarray(0, 4)) === 'RIFF' ||
    String.fromCharCode(...signature.subarray(4, 8)) === 'ftyp' ||
    String.fromCharCode(...signature.subarray(0, 4)) === 'GIF8'
  );
}

function memberOf(document: FirestoreDocument | null, uid: string) {
  if (!document) return false;
  const access = document.fields.access;
  return Boolean(access && typeof access === 'object' && !Array.isArray(access) && access[uid]);
}

export interface FirebaseMediaConfig {
  projectId?: string;
  client?: FirestorePort;
  getAccessToken: () => Promise<string | null>;
  getUid: () => string | null;
  readFile?: (uri: string) => Promise<Uint8Array>;
  readCached?: (householdId: string, remoteRef: string) => Promise<string | null>;
  writeCached?: (householdId: string, remoteRef: string, bytes: Uint8Array, mimeType: string) => Promise<string>;
  compress?: (uri: string) => Promise<{ uri: string; mimeType: string }>;
  now?: () => number;
}

export class FirebaseMediaGateway implements MediaGateway {
  private readonly client: FirestorePort;
  private readonly readFile: (uri: string) => Promise<Uint8Array>;
  private readonly readCached: (householdId: string, remoteRef: string) => Promise<string | null>;
  private readonly writeCached: (
    householdId: string,
    remoteRef: string,
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<string>;
  private readonly compress: (uri: string) => Promise<{ uri: string; mimeType: string }>;
  private readonly now: () => number;

  constructor(private readonly config: FirebaseMediaConfig) {
    this.client =
      config.client ??
      new FirestoreRestClient({
        projectId: config.projectId ?? '',
        getAccessToken: config.getAccessToken,
      });
    this.readFile = config.readFile ?? readLocalFile;
    this.readCached = config.readCached ?? cachedFile;
    this.writeCached = config.writeCached ?? writeCachedFile;
    this.compress = config.compress ?? compressPhoto;
    this.now = config.now ?? Date.now;
  }

  isAvailable(): boolean {
    return this.client.available();
  }

  private uid(): string {
    const uid = this.config.getUid();
    if (!uid) throw new FirebaseMediaError(401, 'Connexion Firebase requise');
    return uid;
  }

  private mediaPath(householdId: string, remoteRef: string): string {
    return `groups/${householdId}/media/${remoteRef}`;
  }

  async upload(
    householdId: string,
    attachment: { id: string; ref: string; mimeType?: string; byteSize?: number },
  ): Promise<{ remoteRef: string; sha256: string; byteSize: number }> {
    const uid = this.uid();
    if (!ID.test(householdId)) throw new Error('Identifiant de groupe invalide');
    const remoteRef = ID.test(attachment.id)
      ? attachment.id
      : attachment.id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
    if (!ID.test(remoteRef)) throw new Error('Identifiant de photo invalide');

    let uri = attachment.ref;
    let mimeType = attachment.mimeType && EXTENSIONS[attachment.mimeType] ? attachment.mimeType : 'image/jpeg';
    let bytes = await this.readFile(uri);
    if (attachment.byteSize !== undefined && attachment.byteSize !== bytes.length) {
      throw new Error('Taille de photo incohérente');
    }
    if (bytes.length > MAX_FIRESTORE_MEDIA_BYTES) {
      const compressed = await this.compress(uri);
      uri = compressed.uri;
      mimeType = compressed.mimeType;
      bytes = await this.readFile(uri);
    }
    if (bytes.length === 0 || bytes.length > MAX_FIRESTORE_MEDIA_BYTES) {
      throw new Error('Photo trop volumineuse pour le stockage Firebase gratuit (700 Kio)');
    }
    if (!isImage(bytes)) throw new Error('Contenu de photo invalide');
    const digest = await sha256(bytes);

    return this.client.runTransaction(async (transaction) => {
      const group = await transaction.get(`groups/${householdId}`);
      if (!memberOf(group, uid)) throw new FirebaseMediaError(403, 'Group access denied');
      const existing = await transaction.get(this.mediaPath(householdId, remoteRef));
      if (existing) {
        if (String(existing.fields.sha256 ?? '') !== digest) {
          throw new FirebaseMediaError(409, 'Media identifier already used with different content');
        }
        return {
          remoteRef,
          sha256: digest,
          byteSize: Number(existing.fields.byteSize ?? bytes.length),
        };
      }
      transaction.set(this.mediaPath(householdId, remoteRef), {
        mimeType,
        byteSize: bytes.length,
        sha256: digest,
        data: toBase64(bytes),
        createdAt: new Date(this.now()).toISOString(),
        uploadedBy: uid,
      });
      return { remoteRef, sha256: digest, byteSize: bytes.length };
    });
  }

  async download(householdId: string, remoteRef: string): Promise<string> {
    const uid = this.uid();
    if (!ID.test(householdId) || !ID.test(remoteRef)) throw new Error('Référence de photo invalide');
    const group = await this.client.getDocument(`groups/${householdId}`);
    if (!memberOf(group, uid)) throw new FirebaseMediaError(403, 'Group access denied');
    const cached = await this.readCached(householdId, remoteRef);
    if (cached) return cached;
    const document = await this.client.getDocument(this.mediaPath(householdId, remoteRef));
    if (!document) throw new FirebaseMediaError(404, 'Media not found');
    const data = document.fields.data;
    if (typeof data !== 'string') throw new FirebaseMediaError(500, 'Media integrity check failed');
    const bytes = fromBase64(data);
    const expected = String(document.fields.sha256 ?? '');
    if (bytes.length !== Number(document.fields.byteSize ?? 0) || (await sha256(bytes)) !== expected) {
      throw new FirebaseMediaError(500, 'Media integrity check failed');
    }
    const mimeType = String(document.fields.mimeType ?? 'image/jpeg');
    return this.writeCached(householdId, remoteRef, bytes, mimeType);
  }

  async remove(householdId: string, remoteRef: string): Promise<void> {
    const uid = this.uid();
    if (!ID.test(householdId) || !ID.test(remoteRef)) throw new Error('Référence de photo invalide');
    await this.client.runTransaction(async (transaction: FirestoreTransaction) => {
      const group = await transaction.get(`groups/${householdId}`);
      if (!memberOf(group, uid)) throw new FirebaseMediaError(403, 'Group access denied');
      const document = await transaction.get(this.mediaPath(householdId, remoteRef));
      if (!document) return;
      const records = await transaction.query(`groups/${householdId}/records`, [
        { field: 'collection', op: '==', value: 'contribution_entries' },
      ]);
      const expenses = await transaction.query(`groups/${householdId}/records`, [
        { field: 'collection', op: '==', value: 'expense_entries' },
      ]);
      const referenced = [...records, ...expenses].some((record) => {
        const value = record.fields.value;
        const attachments = value && typeof value === 'object' && !Array.isArray(value)
          ? (value as { attachments?: unknown }).attachments
          : null;
        return Array.isArray(attachments) && attachments.some(
          (attachment) =>
            attachment &&
            typeof attachment === 'object' &&
            (attachment as { remoteRef?: unknown }).remoteRef === remoteRef,
        );
      });
      if (referenced) throw new FirebaseMediaError(409, 'Media is still referenced by an entry');
      transaction.delete(this.mediaPath(householdId, remoteRef));
    });
  }
}
