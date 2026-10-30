import { LocalAuthAdapter } from '../src/infrastructure/local/LocalAuthAdapter';
import { FirebaseAuthAdapter, firebaseAuthConfig } from '../src/infrastructure/cloud/FirebaseAuthAdapter';
import { SecureStorageGateway } from '../src/application/ports';
import { randomUUID } from 'node:crypto';
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

function store(): SecureStorageGateway {
  const data = new Map<string, string>();
  return { getItem: async k => data.get(k) ?? null, setItem: async (k,v) => { data.set(k,v); },
    deleteItem: async k => { data.delete(k); }, clear: async () => { data.clear(); } };
}
const expired = { userId: 'firebase-a', accessToken: 'expired-test-token', refreshToken: 'test-refresh',
  provider: 'google' as const, expiresAt: '2000-01-01T00:00:00Z', displayName: 'Alice' };
const config = { apiKey: 'public-test-key', projectId: 'test-project', googleWebClientId: 'public-client-id' };

test('two independent local installations never share an identity; signout/restart retains local owner', async () => {
  const storage = store();
  const a = new LocalAuthAdapter({ e2e: false, secureStorage: storage });
  const b = new LocalAuthAdapter({ e2e: false, secureStorage: store() });
  const first = await a.restoreSession();
  expect((await b.restoreSession())!.userId).not.toBe(first!.userId);
  expect(first!.userId).toMatch(/^local-/);
  await a.signOut();
  const restarted = new LocalAuthAdapter({ e2e: false, secureStorage: storage });
  expect((await restarted.restoreSession())!.userId).toBe(first!.userId);
});

test('existing local ledger identity is preserved through migration and signout', async () => {
  const storage = store();
  await storage.setItem('chorescore.auth.session', JSON.stringify({ ...expired,
    provider: 'local', userId: 'chorescore-local-owner', expiresAt: '2999-01-01T00:00:00Z' }));
  const a = new LocalAuthAdapter({ e2e: false, secureStorage: storage });
  expect((await a.restoreSession())!.userId).toBe('chorescore-local-owner');
  await a.signOut();
  expect((await a.restoreSession())!.userId).toBe('chorescore-local-owner');
});

test('Firebase restores offline and coalesces concurrent refreshes with secure persistence', async () => {
  const storage = store();
  const auth = new FirebaseAuthAdapter(config, storage);
  await auth.persistSession(expired);
  const request = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({
    user_id: 'firebase-a', id_token: 'fresh-test-token', refresh_token: 'new-test-refresh', expires_in: '3600',
  }) } as Response);
  expect((await auth.restoreSession())!.userId).toBe('firebase-a');
  expect(request).not.toHaveBeenCalled();
  expect(await Promise.all([auth.getIdToken(), auth.getIdToken()])).toEqual(['fresh-test-token','fresh-test-token']);
  expect(request).toHaveBeenCalledTimes(1);
  const restored = new FirebaseAuthAdapter(config, storage);
  expect((await restored.restoreSession())!.accessToken).toBe('fresh-test-token');
  await auth.signOut();
  await expect(auth.getIdToken()).rejects.toThrow('Authentication required');
  request.mockRestore();
});

test('failed refresh retains pending local work and never returns an expired token', async () => {
  const storage = store();
  const auth = new FirebaseAuthAdapter(config, storage);
  await auth.persistSession(expired); await auth.restoreSession();
  const request = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
  await expect(auth.getIdToken()).rejects.toThrow('403');
  expect(auth.getCurrentUserId()).toBe('firebase-a');
  request.mockRestore();
});

test('a refresh finishing after signout cannot restore authentication', async () => {
  const storage = store();
  const auth = new FirebaseAuthAdapter(config, storage);
  await auth.persistSession(expired); await auth.restoreSession();
  let finish!: (response: Response) => void;
  const request = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const refresh = auth.getIdToken();
  await auth.signOut();
  finish({ ok: true, json: async () => ({ user_id: 'firebase-a', id_token: randomUUID(), refresh_token: 'r', expires_in: '3600' }) } as Response);
  await expect(refresh).rejects.toThrow('Session changed');
  expect(auth.getCurrentUser()).toBeNull();
  expect(await new FirebaseAuthAdapter(config, storage).restoreSession()).toBeNull();
  request.mockRestore();
});

test('the confirmed public Firebase project id is the default and stays overridable', () => {
  const previous = { ...process.env };
  try {
    process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'public-test-key';
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'public-client-id';
    delete process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
    expect(firebaseAuthConfig()).toEqual({
      apiKey: 'public-test-key',
      projectId: 'chorescore-a75b1',
      googleWebClientId: 'public-client-id',
    });
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'other-project';
    expect(firebaseAuthConfig()!.projectId).toBe('other-project');
    delete process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
    expect(firebaseAuthConfig()).toBeNull();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test('a pending secure-storage restore cannot sign the user back in after signout', async () => {
  const storage = store();
  let finish!: (value: string | null) => void;
  const read = jest.spyOn(storage, 'getItem').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const auth = new FirebaseAuthAdapter(config, storage);
  const restore = auth.restoreSession();
  await auth.signOut();
  finish(JSON.stringify(expired));
  expect(await restore).toBeNull();
  expect(auth.getCurrentUser()).toBeNull();
  read.mockRestore();
});

test('a new account never shares the previous account pending token refresh', async () => {
  const storage = store();
  const auth = new FirebaseAuthAdapter(config, storage);
  await auth.persistSession(expired); await auth.restoreSession();
  let finishOld!: (response: Response) => void;
  const request = jest.spyOn(global, 'fetch')
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce({ ok: true, json: async () => ({
      user_id: 'firebase-b', id_token: 'fresh-b', refresh_token: 'refresh-b', expires_in: '3600',
    }) } as Response);
  try {
    const old = auth.getIdToken();
    const oldResult = old.catch(error => error);
    await auth.signOut();
    await auth.persistSession({ ...expired, userId: 'firebase-b', refreshToken: 'refresh-b' });
    await auth.restoreSession();
    const current = auth.getIdToken();
    // A fresh request must start immediately, without waiting for account A.
    expect(request).toHaveBeenCalledTimes(2);
    expect(await current).toBe('fresh-b');
    finishOld({ ok: true, json: async () => ({
      user_id: 'firebase-a', id_token: 'fresh-a', refresh_token: 'refresh-a', expires_in: '3600',
    }) } as Response);
    expect(await oldResult).toBeInstanceOf(Error);
    expect(auth.getCurrentUserId()).toBe('firebase-b');
    expect((await new FirebaseAuthAdapter(config, storage).restoreSession())!.accessToken).toBe('fresh-b');
  } finally { request.mockRestore(); }
});
