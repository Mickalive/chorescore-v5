import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { AppProvider, useApp } from '../src/features/app/AppContext';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

let mockRepos: ReturnType<typeof createInMemoryRepositories>;
const mockSync = { isAvailable: () => true, discoverGroups: jest.fn(), startSync: jest.fn().mockResolvedValue(undefined),
  ensureRemoteGroup: jest.fn(), stopSync: jest.fn().mockResolvedValue(undefined), pushChanges: jest.fn(), pullChanges: jest.fn() };
jest.mock('../src/infrastructure/repositories/RepositoryFactory', () => ({
  ...jest.requireActual('../src/infrastructure/repositories/RepositoryFactory'),
  createRepositoriesWithStatus: async () => ({ repos: mockRepos, degraded: false, backend: 'memory' }),
}));
jest.mock('../src/infrastructure/collaboration/createCollaborationServices', () => ({
  createCollaborationServices: () => ({ sync: mockSync, media: { isAvailable: () => false }, mode: 'firebase' }),
}));
jest.mock('../src/infrastructure/cloud/FirebaseAuthAdapter', () => ({
  firebaseAuthConfig: () => ({ projectId: 'test', apiKey: 'public', googleWebClientId: 'public' }),
  FirebaseAuthAdapter: class {
    getCurrentUserId() { return 'alice'; }
    getCurrentUser() { return { userId: 'alice', displayName: 'Alice', provider: 'google' }; }
    onAuthStateChanged(callback: any) { callback(this.getCurrentUser()); return () => undefined; }
    async restoreSession() { return { userId: 'alice', provider: 'google' }; }
  },
}));
jest.mock('../src/infrastructure/local/LocalAttachmentAdapter', () => ({
  LocalAttachmentAdapter: class { isAvailable() { return false; } async collectGarbage() {} },
}));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

test('persisted groups and local group creation remain usable while cloud discovery never responds', async () => {
  jest.useFakeTimers();
  mockRepos = createInMemoryRepositories();
  await createGroupWithMembers(mockRepos, { name: 'Maison locale', owner: { userId: 'alice', displayName: 'Alice' }, memberNames: ['Bob'] });
  mockSync.discoverGroups.mockReturnValue(new Promise(() => {}));
  mockSync.ensureRemoteGroup.mockReturnValue(new Promise(() => {}));
  let app!: ReturnType<typeof useApp>;
  function Consumer() { app = useApp(); return <Text>{app.isLoading ? 'LOADING' : app.households.map(group => group.name).join(',')}</Text>; }
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<AppProvider><Consumer /></AppProvider>); });
    expect(app.isLoading).toBe(false);
    expect(JSON.stringify(tree.toJSON())).toContain('Maison locale');
    expect(mockSync.discoverGroups).toHaveBeenCalledTimes(1);
    await act(async () => { await app.createHousehold('Deuxième maison hors ligne', ['Charlie'], 'points'); });
    expect(app.households.map(group => group.name)).toContain('Deuxième maison hors ligne');
    expect(mockSync.discoverGroups).toHaveBeenCalledTimes(1); // coalesced while the first discovery is pending
  } finally {
    if (tree) await act(async () => tree.unmount());
    jest.clearAllTimers(); jest.useRealTimers();
  }
});
