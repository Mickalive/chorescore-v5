/**
 * Real Firestore emulator journey.
 *
 * This test talks to the official Firestore emulator over its REST API with
 * the candidate `firebase/firestore.rules` loaded. It uses the production
 * `FirestoreRestClient`, `FirebaseSyncTransport`, `RemoteSyncAdapter` and
 * `FirebaseMediaGateway`; no InMemoryFirestore or deployed project is used.
 *
 * The single workflow starts this file inside `firebase emulators:exec`, which
 * supplies FIRESTORE_EMULATOR_HOST. A plain local `npm test` skips it because
 * there is no emulator to prove anything.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  createInMemoryRepositories,
  AllRepositories,
} from '../src/infrastructure/repositories/RepositoryFactory';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';
import { FirebaseSyncTransport } from '../src/infrastructure/firebase/FirebaseSyncTransport';
import { FirebaseMediaGateway } from '../src/infrastructure/firebase/FirebaseMediaGateway';
import { FirestoreRestClient } from '../src/infrastructure/firebase/FirestoreRestClient';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
  'demo-chorescore-audit';
const describeEmulator = emulatorHost ? describe : describe.skip;
const clock = Date.now();
const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
let tokenSequence = 0;
let idSequence = 0;

function token(uid: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(clock / 1000);
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    sub: uid,
    user_id: uid,
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    iat: now,
    auth_time: now,
    exp: now + 3600,
    firebase: { sign_in_provider: 'custom', identities: {} },
  })}.`;
}

function nodeFetch(url: URL, init: RequestInit = {}): Promise<Response> {
  // jest-expo installs Expo's native winter fetch globally. That implementation
  // has no status metadata outside a React Native runtime, so an emulator test
  // must use Node's HTTP stack directly rather than globalThis.fetch.
  return new Promise((resolve, reject) => {
    console.error('REQ', init.method ?? 'GET', url.pathname + url.search);
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(
      url,
      {
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          console.error('RES', status, url.pathname);
          if (status >= 400) console.error('BODY', text, 'REQBODY', init.body);
        resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => text,
            json: async () => JSON.parse(text),
          } as Response);
        });
      },
    );
    request.on('error', (error) => { console.error('REQERR', url.pathname, error.message); reject(error); });
    if (init.signal) {
      init.signal.addEventListener('abort', () => request.destroy(new Error('Aborted')));
    }
    if (init.body !== undefined && init.body !== null) request.write(init.body as string);
    request.end();
  });
}

function emulatorFetch(fail: { next: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail.next) {
      fail.next = false;
      throw new Error('offline');
    }
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(raw);
    if (url.hostname === 'firestore.googleapis.com') {
      url.protocol = 'http:';
      url.host = emulatorHost!;
    }
    return nodeFetch(url, init);
  }) as typeof fetch;
}

interface Client {
  uid: string;
  repos: AllRepositories;
  sync: RemoteSyncAdapter;
  media: FirebaseMediaGateway;
  transport: FirebaseSyncTransport;
  firestore: FirestoreRestClient;
  cache: Map<string, Uint8Array>;
  fail: { next: boolean };
}

function client(uid: string): Client {
  const fail = { next: false };
  const fetchImpl = emulatorFetch(fail);
  const getAccessToken = async () => token(uid);
  const firestore = new FirestoreRestClient({
    projectId,
    getAccessToken,
    fetchImpl,
  });
  const transport = new FirebaseSyncTransport({
    client: firestore,
    getAccessToken,
    getUid: () => uid,
    now: () => clock,
    createToken: async () => {
      tokenSequence += 1;
      return `${String(tokenSequence).padStart(3, '0')}${'c'.repeat(40)}`;
    },
    createId: () => {
      idSequence += 1;
      return `membership-${idSequence}-${uid}`;
    },
  });
  const repos = createInMemoryRepositories();
  const cache = new Map<string, Uint8Array>();
  const media = new FirebaseMediaGateway({
    client: firestore,
    getAccessToken,
    getUid: () => uid,
    readFile: async (uri) => (uri === 'file://local/photo.jpg' ? photo : new Uint8Array()),
    readCached: async (householdId, ref) =>
      cache.has(`${householdId}:${ref}`) ? `file://cache/${householdId}/${ref}` : null,
    writeCached: async (householdId, ref, bytes) => {
      cache.set(`${householdId}:${ref}`, bytes);
      return `file://cache/${householdId}/${ref}`;
    },
    compress: async (uri) => ({ uri, mimeType: 'image/jpeg' }),
    now: () => clock,
  });
  const sync = new RemoteSyncAdapter({
    request: (method, path, body) => transport.request(method, path, body),
    getAccessToken,
    getRepos: () => repos,
    media,
    pollIntervalMs: 0,
  });
  return { uid, repos, sync, media, transport, firestore, cache, fail };
}

async function householdRevision(target: Client, householdId: string): Promise<number> {
  const document = await target.firestore.getDocument(`groups/${householdId}`);
  return Number(document?.fields.revision ?? 0);
}

describeEmulator('real Firestore rules and collaboration journey', () => {
  jest.setTimeout(120_000);

  test('two accounts, targeted invitation, real deltas, media and owner deletion', async () => {
    const suffix = randomUUID().slice(0, 8);
    const alice = client(`alice-${suffix}`);
    const bob = client(`bob-${suffix}`);
    const mallory = client(`mallory-${suffix}`);

    const { household, ownerMember, namedMembers } = await createGroupWithMembers(alice.repos, {
      name: `Maison ${suffix}`,
      owner: { userId: alice.uid, displayName: 'Alice' },
      memberNames: ['Bob'],
      contributionUnit: 'points',
    });
    const hid = household.id;
    const bobMember = namedMembers[0];

    await alice.sync.ensureRemoteGroup(hid, alice.uid);
    const invitation = await alice.sync.createInvitation(hid, bobMember.id);
    const accepted = await bob.sync.acceptInvitation(invitation.token);
    expect(accepted).toMatchObject({ groupId: hid, memberId: bobMember.id });

    const revisionAfterAcceptance = await householdRevision(alice, hid);
    await bob.sync.acceptInvitation(invitation.token);
    expect(await householdRevision(alice, hid)).toBe(revisionAfterAcceptance);
    const groupDocument = await alice.firestore.getDocument(`groups/${hid}`);
    expect(groupDocument?.fields.memberUids).toEqual([alice.uid, bob.uid]);
    expect(groupDocument?.fields.access).toMatchObject({
      [alice.uid]: { memberId: ownerMember.id, role: 'OWNER' },
      [bob.uid]: { memberId: bobMember.id, role: 'MEMBER' },
    });

    await expect(mallory.sync.pullChanges(hid)).rejects.toMatchObject({ status: 403 });
    expect(await mallory.repos.households.getById(hid)).toBeNull();

    const entry = await alice.repos.contributions.create({
      householdId: hid,
      label: `Cuisine ${suffix}`,
      performedByMemberId: ownerMember.id,
      beneficiaryMemberIds: [ownerMember.id, bobMember.id],
      value: 10,
      unit: 'points',
      persistentTaskId: null,
      occurredAt: new Date(clock).toISOString(),
      createdBy: alice.uid,
    });
    await alice.sync.pushChanges(hid);
    await bob.sync.pullChanges(hid);
    expect(await bob.repos.contributions.getById(entry.id)).toMatchObject({
      label: `Cuisine ${suffix}`,
      value: 10,
      unit: 'points',
    });

    const categoryId = `category-${suffix}`;
    const category = {
      id: categoryId,
      householdId: hid,
      name: 'Ménage',
      defaultTaskRatio: null,
      createdAt: new Date(clock).toISOString(),
      updatedAt: new Date(clock).toISOString(),
    };
    const operation = {
      operationId: `operation-${suffix}`,
      changes: [{ collection: 'categories', id: categoryId, baseVersion: 0, value: category }],
    };
    const first = await alice.transport.request('POST', `/groups/${hid}/mutations`, operation);
    const replay = await alice.transport.request('POST', `/groups/${hid}/mutations`, operation);
    expect(replay).toEqual(first);
    await expect(
      alice.transport.request('POST', `/groups/${hid}/mutations`, {
        ...operation,
        operationId: `conflict-${suffix}`,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await bob.sync.pullChanges(hid);
    const bobCategory = await bob.repos.categories.create({
      householdId: hid,
      name: `Bob ${suffix}`,
      defaultTaskRatio: null,
    });
    bob.fail.next = true;
    await expect(bob.sync.pushChanges(hid)).rejects.toThrow(/offline/);
    await bob.sync.pushChanges(hid);
    await alice.sync.pullChanges(hid);
    expect(await alice.repos.categories.getById(bobCategory.id)).toMatchObject({
      name: `Bob ${suffix}`,
    });

    const remoteRef = `photo-${suffix}`;
    const withPhoto = await alice.repos.contributions.create({
      householdId: hid,
      label: `Photo ${suffix}`,
      performedByMemberId: ownerMember.id,
      beneficiaryMemberIds: [ownerMember.id, bobMember.id],
      value: 2,
      unit: 'points',
      persistentTaskId: null,
      occurredAt: new Date(clock).toISOString(),
      createdBy: alice.uid,
      attachments: [
        {
          id: remoteRef,
          kind: 'photo',
          ref: 'file://local/photo.jpg',
          mimeType: 'image/jpeg',
          byteSize: photo.length,
          createdAt: new Date(clock).toISOString(),
        },
      ],
    });
    await alice.sync.pushChanges(hid);
    await bob.sync.pullChanges(hid);
    const pulled = await bob.repos.contributions.getById(withPhoto.id);
    const pulledRef = pulled?.attachments?.[0]?.remoteRef;
    expect(pulledRef).toBe(remoteRef);
    const downloaded = await bob.media.download(hid, remoteRef);
    expect(Array.from(bob.cache.get(`${hid}:${remoteRef}`) ?? [])).toEqual(Array.from(photo));
    expect(downloaded).toContain('file://cache/');
    await expect(mallory.media.download(hid, remoteRef)).rejects.toMatchObject({ status: 403 });
    await expect(alice.media.remove(hid, remoteRef)).rejects.toMatchObject({ status: 409 });

    await alice.repos.contributions.update(withPhoto.id, { attachments: [] });
    await alice.sync.pushChanges(hid);
    await bob.sync.pullChanges(hid);
    await alice.media.remove(hid, remoteRef);
    bob.cache.delete(`${hid}:${remoteRef}`);
    await expect(bob.media.download(hid, remoteRef)).rejects.toMatchObject({ status: 404 });

    await alice.sync.deleteGroup(hid);
    expect(await alice.repos.households.getById(hid)).toBeNull();
    expect(await bob.repos.households.getById(hid)).not.toBeNull();
    await bob.sync.pullChanges(hid);
    expect(await bob.repos.households.getById(hid)).toBeNull();
    const deletedGroup = await alice.firestore.getDocument(`groups/${hid}`);
    expect(deletedGroup?.fields.deleted).toBe(true);
  });
});
