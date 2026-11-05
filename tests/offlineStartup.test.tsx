import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
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
    userId: string | null = 'alice';
    listeners: any[] = [];
    getCurrentUserId() { return this.userId; }
    getCurrentUser() { return this.userId ? { userId: this.userId, displayName: 'Alice', provider: 'google' } : null; }
    onAuthStateChanged(callback: any) { this.listeners.push(callback); callback(this.getCurrentUser()); return () => undefined; }
    async restoreSession() { return { userId: 'alice', provider: 'google' }; }
    async signOut() { this.userId = null; for (const callback of this.listeners) callback(null); }
  },
}));
jest.mock('../src/infrastructure/local/LocalAttachmentAdapter', () => ({
  LocalAttachmentAdapter: class { isAvailable() { return false; } async collectGarbage() {} },
}));
const mockNativeRequests = new Map<string, any>();
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(), AndroidImportance: { HIGH: 4 }, SchedulableTriggerInputTypes: { DATE: 'date' },
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }), requestPermissionsAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  getAllScheduledNotificationsAsync: jest.fn(async () => [...mockNativeRequests.values()]),
  scheduleNotificationAsync: jest.fn(async request => { mockNativeRequests.set(request.identifier, request); return request.identifier; }),
  cancelScheduledNotificationAsync: jest.fn(async id => { mockNativeRequests.delete(id); }),
}));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

beforeEach(async () => { jest.clearAllMocks(); mockNativeRequests.clear(); await AsyncStorage.clear(); });

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


test('startup and data changes reconcile native reminders, and signout cancels private reminders', async () => {
  jest.useFakeTimers();
  mockRepos = createInMemoryRepositories();
  const { household, ownerMember } = await createGroupWithMembers(mockRepos, { name: 'Maison', owner: { userId: 'alice', displayName: 'Alice' }, memberNames: ['Bob'] });
  const makeTodo = () => mockRepos.todos.create({ householdId: household.id, title: 'Rappel partagé', kind: 'task', status: 'todo',
    assigneeMemberId: ownerMember.id, beneficiaryMemberIds: [ownerMember.id], dueAt: null,
    reminderAt: new Date(Date.now() + 3600000).toISOString(), notes: '', persistentTaskId: null });
  const todo = await makeTodo();
  mockSync.discoverGroups.mockReturnValue(new Promise(() => {}));
  let app!: ReturnType<typeof useApp>;
  function Consumer() { app = useApp(); return <Text>{app.isLoading ? 'LOADING' : 'READY'}</Text>; }
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<AppProvider><Consumer /></AppProvider>); });
    await act(async () => { await jest.advanceTimersByTimeAsync(300); });
    expect(mockNativeRequests.get(`chorescore-todo:${todo.id}`).content).toMatchObject({
      title: 'Rappel : Rappel partagé', data: { userId: 'alice', householdId: household.id },
    });
    await mockRepos.todos.update(todo.id, { status: 'completed', completedAt: new Date().toISOString() });
    await act(async () => { app.emitDataChange('todo', household.id); await jest.advanceTimersByTimeAsync(300); });
    expect(mockNativeRequests.size).toBe(0);
    const next = await makeTodo();
    await act(async () => { app.emitDataChange('todo', household.id); await jest.advanceTimersByTimeAsync(300); });
    expect(mockNativeRequests.has(`chorescore-todo:${next.id}`)).toBe(true);
    await act(async () => { await app.signOut(); });
    expect(mockNativeRequests.size).toBe(0);
    expect(await app.services.notifications.getEnabled()).toBe(true);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  } finally {
    if (tree) await act(async () => tree.unmount());
    jest.clearAllTimers(); jest.useRealTimers();
  }
});


test('a remotely deleted selected group never switches an open form to another group', async () => {
  jest.useFakeTimers();
  mockRepos = createInMemoryRepositories();
  const owner = { userId: 'alice', displayName: 'Alice' };
  const first = await createGroupWithMembers(mockRepos, { name: 'Premier groupe', owner, memberNames: ['Bob'] });
  const second = await createGroupWithMembers(mockRepos, { name: 'Autre groupe', owner, memberNames: ['Charlie'] });
  mockSync.discoverGroups.mockReturnValue(new Promise(() => {}));
  let app!: ReturnType<typeof useApp>;
  function Consumer() { app = useApp(); return <Text>{app.currentHouseholdId}</Text>; }
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<AppProvider><Consumer /></AppProvider>); });
    await act(async () => { app.setCurrentHouseholdId(first.household.id); await app.loadHouseholds(); });
    expect(app.currentHouseholdId).toBe(first.household.id);
    await mockRepos.households.delete(first.household.id);
    await act(async () => { await app.loadHouseholds(); });
    expect(app.households.map(group => group.id)).toEqual([second.household.id]);
    expect(app.currentHouseholdId).toBeNull();
    await act(async () => { await app.loadHouseholds(); });
    expect(app.currentHouseholdId).toBeNull();
    await act(async () => { app.setCurrentHouseholdId(second.household.id); await app.loadHouseholds(); });
    expect(app.currentHouseholdId).toBe(second.household.id);
  } finally {
    if (tree) await act(async () => tree.unmount());
    jest.clearAllTimers(); jest.useRealTimers();
  }
});
