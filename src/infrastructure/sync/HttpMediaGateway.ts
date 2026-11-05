/**
 * Private media transport for the frugal collaboration server.
 *
 * Files are uploaded under the group ACL before an entry references them and
 * downloaded lazily into a private cache. No public URL is produced, and a
 * local path is never sent to the authority.
 */
import { MediaGateway } from '../../application/ports';
import { collaborationBaseUrl } from './collaborationUrl';

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
};

class MediaHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'MediaHttpError';
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
  const extension = EXTENSIONS[mimeType] ?? 'jpg';
  const file = new File(directory, `${remoteRef}.${extension}`);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file.uri;
}

export interface HttpMediaConfig {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  getUid?: () => string | null;
  canReadCached?: (householdId: string, uid: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  readFile?: (uri: string) => Promise<Uint8Array>;
  readCached?: (householdId: string, remoteRef: string) => Promise<string | null>;
  writeCached?: (
    householdId: string,
    remoteRef: string,
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<string>;
}

export class HttpMediaGateway implements MediaGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (uri: string) => Promise<Uint8Array>;
  private readonly readCached: (householdId: string, remoteRef: string) => Promise<string | null>;
  private readonly writeCached: (
    householdId: string,
    remoteRef: string,
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<string>;

  constructor(private readonly config: HttpMediaConfig) {
    this.baseUrl = collaborationBaseUrl(config.baseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.readFile = config.readFile ?? readLocalFile;
    this.readCached = config.readCached ?? cachedFile;
    this.writeCached = config.writeCached ?? writeCachedFile;
  }

  isAvailable(): boolean {
    return this.baseUrl.length > 0;
  }

  private async token(): Promise<string> {
    const token = await this.config.getAccessToken();
    if (!token) throw new Error('Connexion requise pour les photos partagées');
    return token;
  }

  private async actor(): Promise<{ token: string; uid: string | null | undefined }> {
    const uid = this.config.getUid?.();
    const actor = { token: await this.token(), uid };
    await this.requireActor(actor);
    return actor;
  }

  private async requireActor(actor: { token: string; uid: string | null | undefined }): Promise<void> {
    const unchanged = this.config.getUid
      ? Boolean(actor.uid) && this.config.getUid() === actor.uid
      : await this.config.getAccessToken() === actor.token;
    if (!unchanged) throw new MediaHttpError(401, 'Account changed during photo operation');
  }

  private async request(actor: { token: string; uid: string | null | undefined }, method: 'GET' | 'HEAD' | 'PUT' | 'DELETE', path: string, body?: Uint8Array, mimeType?: string): Promise<Response> {
    await this.requireActor(actor);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${actor.token}`,
          ...(mimeType ? { 'Content-Type': mimeType } : {}),
        },
        body: body as BodyInit | undefined,
        signal: controller.signal,
      });
      await this.requireActor(actor);
      return response;
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        throw new Error('Délai de transfert de la photo dépassé');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async failure(response: Response): Promise<never> {
    let message = `Erreur photo (${response.status})`;
    try {
      const data = await response.json() as { error?: unknown };
      if (typeof data.error === 'string') message = data.error;
    } catch { /* binary or empty error body */ }
    throw new MediaHttpError(response.status, message);
  }

  async upload(
    householdId: string,
    attachment: { id: string; ref: string; mimeType?: string; byteSize?: number },
  ): Promise<{ remoteRef: string; sha256: string; byteSize: number }> {
    const actor = await this.actor();
    if (!ID.test(householdId)) throw new Error('Identifiant de groupe invalide');
    const remoteRef = ID.test(attachment.id) ? attachment.id : attachment.id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
    if (!ID.test(remoteRef)) throw new Error('Identifiant de photo invalide');
    const mimeType = attachment.mimeType && EXTENSIONS[attachment.mimeType] ? attachment.mimeType : 'image/jpeg';
    const bytes = await this.readFile(attachment.ref);
    if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new Error('Taille de photo invalide');
    if (attachment.byteSize !== undefined && attachment.byteSize !== bytes.length) {
      throw new Error('Taille de photo incohérente');
    }
    const response = await this.request(
      actor,
      'PUT',
      `/groups/${encodeURIComponent(householdId)}/media/${encodeURIComponent(remoteRef)}`,
      bytes,
      mimeType,
    );
    if (!response.ok) await this.failure(response);
    const data = await response.json() as { id?: unknown; sha256?: unknown; byteSize?: unknown };
    await this.requireActor(actor);
    if (data.id !== remoteRef || typeof data.sha256 !== 'string' || data.byteSize !== bytes.length) {
      throw new Error('Réponse de stockage photo invalide');
    }
    return { remoteRef, sha256: data.sha256, byteSize: data.byteSize };
  }

  async download(householdId: string, remoteRef: string): Promise<string> {
    if (!ID.test(householdId) || !ID.test(remoteRef)) throw new Error('Référence de photo invalide');
    const actor = await this.actor();
    const cached = await this.readCached(householdId, remoteRef);
    await this.requireActor(actor);
    const path = `/groups/${encodeURIComponent(householdId)}/media/${encodeURIComponent(remoteRef)}`;
    if (cached) {
      // A private file's presence is not authorization for the active account.
      // HEAD checks the current group ACL without retransferring the photo.
      try {
        const response = await this.request(actor, 'HEAD', path);
        if (!response.ok) await this.failure(response);
      } catch (error) {
        // Offline access uses persisted membership for this exact account.
        // An explicit server denial/deletion always wins over that snapshot.
        if (error instanceof MediaHttpError || !actor.uid || !this.config.canReadCached ||
            !await this.config.canReadCached(householdId, actor.uid)) throw error;
        await this.requireActor(actor);
      }
      return cached;
    }
    const response = await this.request(
      actor,
      'GET',
      path,
    );
    if (!response.ok) await this.failure(response);
    const mimeType = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim().toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());
    await this.requireActor(actor);
    if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new Error('Taille de photo invalide');
    const uri = await this.writeCached(householdId, remoteRef, bytes, mimeType);
    await this.requireActor(actor);
    return uri;
  }

  async remove(householdId: string, remoteRef: string): Promise<void> {
    const actor = await this.actor();
    if (!ID.test(householdId) || !ID.test(remoteRef)) throw new Error('Référence de photo invalide');
    const response = await this.request(
      actor,
      'DELETE',
      `/groups/${encodeURIComponent(householdId)}/media/${encodeURIComponent(remoteRef)}`,
    );
    if (!response.ok && response.status !== 404 && response.status !== 409) {
      await this.failure(response);
    }
  }
}

/** Used by local/E2E builds where no private media authority is configured. */
export class UnavailableMediaGateway implements MediaGateway {
  isAvailable(): boolean { return false; }
  async upload(): Promise<never> { throw new Error('Stockage photo partagé indisponible'); }
  async download(): Promise<never> { throw new Error('Stockage photo partagé indisponible'); }
  async remove(): Promise<never> { throw new Error('Stockage photo partagé indisponible'); }
}
