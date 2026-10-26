import {
  createCollaborationServices,
  selectCollaborationMode,
} from '../src/infrastructure/collaboration/createCollaborationServices';
import { FirebaseMediaGateway } from '../src/infrastructure/firebase/FirebaseMediaGateway';
import { LocalSyncAdapter } from '../src/infrastructure/local/LocalSyncAdapter';
import { HttpMediaGateway } from '../src/infrastructure/sync/HttpMediaGateway';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';

function config(overrides: Partial<Parameters<typeof createCollaborationServices>[0]> = {}) {
  return {
    getRepos: () => createInMemoryRepositories(),
    getAccessToken: async () => 'token',
    hasCloudIdentity: true,
    ...overrides,
  };
}

test('the HTTPS server wins when both authorities are configured', () => {
  expect(
    selectCollaborationMode({
      hasCloudIdentity: true,
      collaborationUrl: 'https://collab.example',
      firebaseProjectId: 'chorescore-a75b1',
    }),
  ).toBe('http');
  expect(
    selectCollaborationMode({
      hasCloudIdentity: true,
      collaborationUrl: '  ',
      firebaseProjectId: 'chorescore-a75b1',
    }),
  ).toBe('firebase');
  expect(
    selectCollaborationMode({
      hasCloudIdentity: true,
      collaborationUrl: '',
      firebaseProjectId: '',
    }),
  ).toBe('local');
});

test('a local identity can never select a cloud authority', () => {
  expect(
    selectCollaborationMode({
      hasCloudIdentity: false,
      collaborationUrl: 'https://collab.example',
      firebaseProjectId: 'chorescore-a75b1',
    }),
  ).toBe('local');
});

test('Firebase Spark selects the Firestore transport and private media without a server URL', () => {
  const services = createCollaborationServices(
    config({
      collaborationUrl: '',
      firebase: { projectId: 'chorescore-a75b1', getUid: () => 'alice' },
    }),
  );
  expect(services.mode).toBe('firebase');
  expect(services.sync).toBeInstanceOf(RemoteSyncAdapter);
  expect(services.media).toBeInstanceOf(FirebaseMediaGateway);
  expect(services.sync.isAvailable()).toBe(true);
});

test('an HTTPS server keeps the HTTP media gateway', () => {
  const services = createCollaborationServices(
    config({
      collaborationUrl: 'https://collab.example/',
      firebase: { projectId: 'chorescore-a75b1', getUid: () => 'alice' },
    }),
  );
  expect(services.mode).toBe('http');
  expect(services.sync).toBeInstanceOf(RemoteSyncAdapter);
  expect(services.media).toBeInstanceOf(HttpMediaGateway);
  expect(services.media.isAvailable()).toBe(true);
});

test('without a cloud identity the app stays honestly local', () => {
  const services = createCollaborationServices(
    config({
      hasCloudIdentity: false,
      collaborationUrl: 'https://collab.example',
      firebase: { projectId: 'chorescore-a75b1', getUid: () => null },
    }),
  );
  expect(services.mode).toBe('local');
  expect(services.sync).toBeInstanceOf(LocalSyncAdapter);
  expect(services.sync.isAvailable()).toBe(false);
  expect(services.media.isAvailable()).toBe(false);
});
