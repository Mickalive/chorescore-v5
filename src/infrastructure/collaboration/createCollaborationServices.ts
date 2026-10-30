import { combineNetworkMetrics } from '../../domain/services/networkCost';
/**
 * Chooses the collaboration authority used by a normal build.
 *
 * Precedence is explicit:
 *   1. an HTTPS collaboration server when EXPO_PUBLIC_COLLAB_URL is set,
 *   2. otherwise the Firestore Spark authority (no server, no Blaze),
 *   3. otherwise the honest local-only adapter.
 *
 * A cloud backend is only selected for a real Firebase session. A local
 * identity can never mint a token for either remote authority.
 */
import { MediaGateway, SyncGateway } from '../../application/ports';
import type { AllRepositories } from '../repositories/RepositoryFactory';
import { FirebaseMediaGateway } from '../firebase/FirebaseMediaGateway';
import { FirebaseSyncTransport } from '../firebase/FirebaseSyncTransport';
import { LocalSyncAdapter } from '../local/LocalSyncAdapter';
import { HttpMediaGateway, UnavailableMediaGateway } from '../sync/HttpMediaGateway';
import { RemoteSyncAdapter } from '../sync/RemoteSyncAdapter';

export type CollaborationMode = 'http' | 'firebase' | 'local';

export interface CollaborationSelectionInput {
  hasCloudIdentity: boolean;
  collaborationUrl?: string;
  firebaseProjectId?: string | null;
}

export function selectCollaborationMode(input: CollaborationSelectionInput): CollaborationMode {
  if (!input.hasCloudIdentity) return 'local';
  if ((input.collaborationUrl ?? '').trim().length > 0) return 'http';
  if ((input.firebaseProjectId ?? '').trim().length > 0) return 'firebase';
  return 'local';
}

export interface FirebaseCollaborationConfig {
  projectId: string;
  getUid: () => string | null;
  fetchImpl?: typeof fetch;
}

export interface CollaborationServicesConfig {
  getRepos: () => AllRepositories;
  getAccessToken: () => Promise<string | null>;
  hasCloudIdentity: boolean;
  collaborationUrl?: string;
  firebase?: FirebaseCollaborationConfig;
}

export interface CollaborationServices {
  mode: CollaborationMode;
  sync: SyncGateway;
  media: MediaGateway;
}

export function createCollaborationServices(
  config: CollaborationServicesConfig,
): CollaborationServices {
  const collaborationUrl = (config.collaborationUrl ?? '').trim();
  const mode = selectCollaborationMode({
    hasCloudIdentity: config.hasCloudIdentity,
    collaborationUrl,
    firebaseProjectId: config.firebase?.projectId,
  });

  if (mode === 'http') {
    const media = new HttpMediaGateway({
      baseUrl: collaborationUrl,
      getAccessToken: config.getAccessToken,
    });
    return {
      mode,
      media,
      sync: new RemoteSyncAdapter({
        baseUrl: collaborationUrl,
        getAccessToken: config.getAccessToken,
        getRepos: config.getRepos,
        media,
      }),
    };
  }

  if (mode === 'firebase' && config.firebase) {
    const { projectId, getUid, fetchImpl } = config.firebase;
    const transport = new FirebaseSyncTransport({
      projectId,
      getAccessToken: config.getAccessToken,
      getUid,
      fetchImpl,
    });
    const media = new FirebaseMediaGateway({
      projectId,
      getAccessToken: config.getAccessToken,
      getUid,
      fetchImpl,
    });
    return {
      mode,
      media,
      sync: new RemoteSyncAdapter({
        request: (method, path, body) => transport.request(method, path, body),
        getNetworkMetrics: () => combineNetworkMetrics(transport.getNetworkMetrics(), media.getNetworkMetrics()),
        getAccessToken: config.getAccessToken,
        getRepos: config.getRepos,
        media,
      }),
    };
  }

  return {
    mode: 'local',
    sync: new LocalSyncAdapter(),
    media: new UnavailableMediaGateway(),
  };
}
