/**
 * Private Firestore media on the free Spark plan: bounded compression,
 * exact-byte download, tenant isolation, deduplication and reference guard.
 * This is not a real Firebase deployment or a security-rules execution.
 */
import { FirebaseMediaGateway, MAX_FIRESTORE_MEDIA_BYTES } from '../src/infrastructure/firebase/FirebaseMediaGateway';
import { InMemoryFirestore } from './helpers/InMemoryFirestore';

const firestore = new InMemoryFirestore();
const files = new Map<string, Uint8Array>();
const cache = new Map<string, Uint8Array>();
const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

function gateway(uid: string, compress = async (uri: string) => ({ uri, mimeType: 'image/jpeg' })) {
  return new FirebaseMediaGateway({
    client: firestore,
    getAccessToken: async () => `token-${uid}`,
    getUid: () => uid,
    readFile: async (uri) => files.get(uri) ?? new Uint8Array(),
    readCached: async (householdId, ref) => (cache.has(`${householdId}:${ref}`) ? `file://${householdId}/${ref}` : null),
    writeCached: async (householdId, ref, bytes) => {
      cache.set(`${householdId}:${ref}`, bytes);
      return `file://${householdId}/${ref}`;
    },
    compress,
    now: () => Date.parse('2026-10-26T10:00:00.000Z'),
  });
}

beforeAll(() => {
  firestore.seed('groups/family', {
    ownerId: 'alice',
    revision: 1,
    household: { id: 'family', name: 'Famille', ownerId: 'alice' },
    memberUids: ['alice', 'bob'],
    access: {
      alice: { memberId: 'alice-member', role: 'OWNER' },
      bob: { memberId: 'bob-member', role: 'MEMBER' },
    },
    createdAt: '2026-10-26T10:00:00.000Z',
  });
  files.set('file://local/photo.jpg', photo);
});

test('photos are private, bounded and downloaded byte-for-byte by members only', async () => {
  const alice = gateway('alice');
  const bob = gateway('bob');
  const mallory = gateway('mallory');

  const uploaded = await alice.upload('family', {
    id: 'photo-1',
    ref: 'file://local/photo.jpg',
    mimeType: 'image/jpeg',
    byteSize: photo.length,
  });
  expect(uploaded).toEqual({
    remoteRef: 'photo-1',
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    byteSize: photo.length,
  });
  const stored = firestore.read('groups/family/media/photo-1');
  expect(stored?.fields).toMatchObject({
    mimeType: 'image/jpeg',
    byteSize: photo.length,
    uploadedBy: 'alice',
  });
  expect(typeof stored?.fields.data).toBe('string');

  await expect(alice.upload('family', {
    id: 'photo-1',
    ref: 'file://local/photo.jpg',
    mimeType: 'image/jpeg',
  })).resolves.toEqual(uploaded);

  const downloaded = await bob.download('family', 'photo-1');
  expect(downloaded).toBe('file://family/photo-1');
  expect(Array.from(cache.get('family:photo-1')!)).toEqual(Array.from(photo));

  await expect(mallory.download('family', 'photo-1')).rejects.toMatchObject({ status: 403 });
  await expect(mallory.upload('family', {
    id: 'photo-2',
    ref: 'file://local/photo.jpg',
  })).rejects.toMatchObject({ status: 403 });
  expect(cache.has('family:photo-1')).toBe(true);
});

test('oversized originals are compressed, bad payloads rejected and references protected', async () => {
  const alice = gateway('alice');
  const small = new Uint8Array(MAX_FIRESTORE_MEDIA_BYTES + 1);
  small.set(photo);
  files.set('file://local/large.jpg', small);
  files.set('file://local/small.jpg', photo);

  const compressing = gateway('alice', async () => ({
    uri: 'file://local/small.jpg',
    mimeType: 'image/jpeg',
  }));
  const compressed = await compressing.upload('family', {
    id: 'photo-large',
    ref: 'file://local/large.jpg',
    mimeType: 'image/jpeg',
  });
  expect(compressed.byteSize).toBe(photo.length);

  const refusing = gateway('alice');
  await expect(refusing.upload('family', {
    id: 'photo-too-large',
    ref: 'file://local/large.jpg',
    mimeType: 'image/jpeg',
  })).rejects.toThrow(/700 Kio/);

  files.set('file://local/fake.jpg', new Uint8Array([1, 2, 3, 4]));
  await expect(alice.upload('family', {
    id: 'photo-fake',
    ref: 'file://local/fake.jpg',
    mimeType: 'image/jpeg',
  })).rejects.toThrow(/invalide/);

  files.set('file://local/other.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 9, 9, 9]));
  await expect(alice.upload('family', {
    id: 'photo-1',
    ref: 'file://local/other.jpg',
    mimeType: 'image/jpeg',
  })).rejects.toMatchObject({ status: 409 });

  firestore.seed('groups/family/records/contribution_entries:entry-1', {
    id: 'entry-1',
    collection: 'contribution_entries',
    version: 1,
    value: {
      id: 'entry-1',
      householdId: 'family',
      attachments: [{ id: 'a', kind: 'photo', ref: 'media:photo-1', remoteRef: 'photo-1' }],
    },
    updatedAt: '2026-10-26T10:00:00.000Z',
  });
  await expect(alice.remove('family', 'photo-1')).rejects.toMatchObject({ status: 409 });
  expect(firestore.read('groups/family/media/photo-1')).not.toBeNull();

  firestore.seed('groups/family/records/contribution_entries:entry-1', {
    id: 'entry-1',
    collection: 'contribution_entries',
    version: 2,
    value: { id: 'entry-1', householdId: 'family', attachments: [] },
    updatedAt: '2026-10-26T10:00:00.000Z',
  });
  await alice.remove('family', 'photo-1');
  expect(firestore.read('groups/family/media/photo-1')).toBeNull();
});
