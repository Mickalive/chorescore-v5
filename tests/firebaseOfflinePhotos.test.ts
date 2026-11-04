import { FirebaseMediaGateway } from '../src/infrastructure/firebase/FirebaseMediaGateway';
import { FirestoreHttpError } from '../src/infrastructure/firebase/FirestorePort';
import { InMemoryFirestore } from './helpers/InMemoryFirestore';

function setup(error: Error, membership = true) {
  const client = new InMemoryFirestore();
  jest.spyOn(client, 'getDocument').mockRejectedValue(error);
  let uid: string | null = 'alice';
  const permission = jest.fn(async (_householdId: string, _uid: string) => membership);
  const readCached = jest.fn(async () => 'file://private/photo.jpg');
  const media = new FirebaseMediaGateway({ client, getUid: () => uid,
    getAccessToken: async () => 'token', readCached, canReadCached: permission });
  return { media, permission, readCached, switchAccount: (next: string | null) => { uid = next; } };
}

test('an offline member can reopen a previously downloaded Firebase photo', async () => {
  const { media, permission } = setup(new TypeError('Network request failed'));
  await expect(media.download('family', 'photo')).resolves.toBe('file://private/photo.jpg');
  expect(permission).toHaveBeenCalledWith('family', 'alice');
});

test.each([401, 403, 404])('an explicit Firebase refusal (%i) never falls back to private cached bytes', async status => {
  const { media, permission, readCached } = setup(new FirestoreHttpError(status, 'denied'));
  await expect(media.download('family', 'photo')).rejects.toMatchObject({ status });
  expect(permission).not.toHaveBeenCalled();
  expect(readCached).not.toHaveBeenCalled();
});

test('offline cache is denied without persisted membership for the current account', async () => {
  const { media, readCached } = setup(new TypeError('offline'), false);
  await expect(media.download('family', 'photo')).rejects.toThrow('offline');
  expect(readCached).not.toHaveBeenCalled();
});

test('switching accounts while checking offline membership cannot expose the old account photo', async () => {
  const { media, permission, switchAccount, readCached } = setup(new TypeError('offline'));
  permission.mockImplementationOnce(async () => { switchAccount('mallory'); return true; });
  await expect(media.download('family', 'photo')).rejects.toMatchObject({ status: 401 });
  expect(readCached).not.toHaveBeenCalled();
});

test('an online member cannot reopen cached bytes after the Firebase photo was deleted', async () => {
  const client = new InMemoryFirestore();
  client.seed('groups/family', { access: { alice: { role: 'OWNER' } } });
  const media = new FirebaseMediaGateway({ client, getUid: () => 'alice',
    getAccessToken: async () => 'token', readCached: async () => 'file://private/deleted.jpg' });
  await expect(media.download('family', 'deleted-photo')).rejects.toMatchObject({ status: 404 });
});
