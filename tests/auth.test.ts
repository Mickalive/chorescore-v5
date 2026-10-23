import { LocalAuthAdapter } from '../src/infrastructure/local/LocalAuthAdapter';
import { FirebaseAuthAdapter } from '../src/infrastructure/cloud/FirebaseAuthAdapter';
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
