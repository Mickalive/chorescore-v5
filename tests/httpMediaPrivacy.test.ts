import { HttpMediaGateway } from '../src/infrastructure/sync/HttpMediaGateway';

test('a cached HTTP photo still requires a session', async () => {
  const media = new HttpMediaGateway({ baseUrl: 'https://authority.invalid',
    getAccessToken: async () => null, readCached: async () => 'file://private.jpg' });
  await expect(media.download('group', 'photo')).rejects.toThrow(/Connexion/);
});

test('switching account during a cached photo read cannot return the previous photo', async () => {
  let token = 'alice';
  const media = new HttpMediaGateway({ baseUrl: 'https://authority.invalid',
    getAccessToken: async () => token,
    fetchImpl: jest.fn(async () => ({ ok: true, status: 200 })) as any,
    readCached: async () => { token = 'bob'; return 'file://alice.jpg'; } });
  await expect(media.download('group', 'photo')).rejects.toThrow(/Account changed/);
});

test('switching account while reading a local upload prevents sending it as the new account', async () => {
  let token = 'alice';
  const fetchImpl = jest.fn();
  const media = new HttpMediaGateway({ baseUrl: 'https://authority.invalid',
    getAccessToken: async () => token, fetchImpl,
    readFile: async () => { token = 'bob'; return new Uint8Array([1, 2, 3]); } });
  await expect(media.upload('group', { id: 'photo', ref: 'file://alice.jpg' })).rejects.toThrow(/Account changed/);
  expect(fetchImpl).not.toHaveBeenCalled();
});
