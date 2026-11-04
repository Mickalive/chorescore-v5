import { FirebaseAuthAdapter } from '../src/infrastructure/cloud/FirebaseAuthAdapter';
import { SecureStorageGateway } from '../src/application/ports';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: {
  configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn(), getTokens: jest.fn(),
} }));

function storage(): SecureStorageGateway {
  const values = new Map<string, string>();
  return { getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    deleteItem: async key => { values.delete(key); }, clear: async () => { values.clear(); } };
}
const config = { apiKey: 'public-test-key', projectId: 'test-project', googleWebClientId: 'web-client' };
const google = jest.mocked(GoogleSignin);

beforeEach(() => {
  jest.clearAllMocks();
  google.hasPlayServices.mockResolvedValue(true);
  google.getTokens.mockResolvedValue({ idToken: 'google-token', accessToken: 'google-access' });
});
afterEach(() => jest.restoreAllMocks());

test('double tapping Google sign-in opens one native flow and persists one Firebase session', async () => {
  const secure = storage();
  const auth = new FirebaseAuthAdapter(config, secure);
  let complete!: (value: any) => void;
  google.signIn.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({
    localId: 'alice', idToken: 'firebase-token', refreshToken: 'refresh', expiresIn: '3600', displayName: 'Alice',
  }) } as Response);
  const first = auth.signInWithGoogle();
  const second = auth.signInWithGoogle();
  await Promise.resolve();
  expect(google.signIn).toHaveBeenCalledTimes(1);
  complete({ type: 'success', data: {} });
  const users = await Promise.all([first, second]);
  expect(users.map(user => user?.userId)).toEqual(['alice', 'alice']);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await new FirebaseAuthAdapter(config, secure).restoreSession())?.userId).toBe('alice');
});

test('a cancelled Google sheet can be retried without creating a Firebase session', async () => {
  const auth = new FirebaseAuthAdapter(config, storage());
  google.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  const fetch = jest.spyOn(global, 'fetch');
  expect(await auth.signInWithGoogle()).toBeNull();
  expect(await auth.signInWithGoogle()).toBeNull();
  expect(google.signIn).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(auth.getCurrentUser()).toBeNull();
});

test('signing out while the native Google sheet is open cannot restore the account later', async () => {
  const secure = storage();
  const auth = new FirebaseAuthAdapter(config, secure);
  let complete!: (value: any) => void;
  google.signIn.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({
    localId: 'alice', idToken: 'firebase-token', refreshToken: 'refresh', expiresIn: '3600',
  }) } as Response);
  const pending = auth.signInWithGoogle();
  await Promise.resolve();
  await auth.signOut();
  complete({ type: 'success', data: {} });
  await expect(pending).rejects.toThrow('Sign-in cancelled');
  expect(fetch).not.toHaveBeenCalled();
  expect(auth.getCurrentUser()).toBeNull();
  expect(await new FirebaseAuthAdapter(config, secure).restoreSession()).toBeNull();
});
