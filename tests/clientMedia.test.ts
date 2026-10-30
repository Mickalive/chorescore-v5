/**
 * Private photo collaboration: two disk-backed SQLite clients, the real HTTP
 * authority and the real HttpMediaGateway transport (with an injected local
 * filesystem so the test does not need an Android native module).
 *
 * Proves that an entry references only uploaded private media, that the other
 * member can download the exact bytes, that outsiders cannot, and that a
 * response lost after an upload/commit is retried without duplicates.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CollaborationStore } from '../backend/store';
import { createCollaborationServer } from '../backend/server';
import { FirebaseTokenVerifier } from '../backend/auth';
import {
  createSqliteRepositories,
  AllRepositories,
} from '../src/infrastructure/repositories/RepositoryFactory';
import { closeDatabase } from '../src/infrastructure/local/SqliteStorage';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';
import { HttpMediaGateway } from '../src/infrastructure/sync/HttpMediaGateway';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async (name: string) => {
    const sqlite = (process as any).getBuiltinModule('node:sqlite');
    const directory = (globalThis as any).__CHORESCORE_SQLITE_DIR as string;
    const native = new sqlite.DatabaseSync(`${directory}/${name}`);
    return {
      execAsync: async (sql: string) => native.exec(sql),
      runAsync: async (sql: string, ...args: any[]) =>
        native.prepare(sql).run(...(Array.isArray(args[0]) ? args[0] : args)),
      getAllAsync: async (sql: string, ...args: any[]) =>
        native.prepare(sql).all(...(Array.isArray(args[0]) ? args[0] : args)),
      getFirstAsync: async (sql: string, ...args: any[]) =>
        native.prepare(sql).get(...(Array.isArray(args[0]) ? args[0] : args)) ?? null,
      closeAsync: async () => native.close(),
      withTransactionAsync: async (fn: () => Promise<void>) => {
        native.exec('BEGIN');
        try {
          await fn();
          native.exec('COMMIT');
        } catch (error) {
          native.exec('ROLLBACK');
          throw error;
        }
      },
    };
  },
}));

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });

function token(uid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message =
    `${encode({ alg: 'RS256', kid: 'test-key' })}.` +
    encode({
      aud: 'chorescore-test',
      iss: 'https://securetoken.google.com/chorescore-test',
      sub: uid,
      iat: now,
      auth_time: now,
      exp: now + 3600,
    });
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), keys.privateKey).toString('base64url')}`;
}

function nodeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(target);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: {
              get: (name: string) => {
                const value = response.headers[name.toLowerCase()];
                return Array.isArray(value) ? value[0] ?? null : value ?? null;
              },
            },
            text: async () => bytes.toString('utf8'),
            json: async () => JSON.parse(bytes.toString('utf8')),
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          } as unknown as Response);
        });
      },
    );
    req.on('error', reject);
    init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')));
    if (init?.body) req.write(init.body as string | Uint8Array);
    req.end();
  });
}

const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(96, 7)]);

let directory: string;
let store: CollaborationStore;
let server: ReturnType<typeof createCollaborationServer>;
let port: number;
let baseUrl: string;

interface Client {
  uid: string;
  databaseName: string;
  repos: AllRepositories;
  sync: RemoteSyncAdapter;
  media: HttpMediaGateway;
  state: { online: boolean; loseNextResponse: boolean };
  files: Map<string, Uint8Array>;
  cache: Map<string, string>;
}

function openClient(uid: string, databaseName: string): Client {
  const state = { online: true, loseNextResponse: false };
  const files = new Map<string, Uint8Array>();
  const cache = new Map<string, string>();
  const client = {
    uid,
    databaseName,
    repos: null as unknown as AllRepositories,
    sync: null as unknown as RemoteSyncAdapter,
    media: null as unknown as HttpMediaGateway,
    state,
    files,
    cache,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!state.online) throw new Error('network offline');
    const response = await nodeFetch(input, init);
    if (state.loseNextResponse) {
      state.loseNextResponse = false;
      throw new Error('response lost after commit');
    }
    return response;
  };
  client.media = new HttpMediaGateway({
    baseUrl,
    getAccessToken: async () => token(uid),
    fetchImpl,
    readFile: async (uri) => {
      const bytes = files.get(uri);
      if (!bytes) throw new Error(`missing local file ${uri}`);
      return bytes;
    },
    readCached: async (householdId, remoteRef) =>
      cache.get(`${householdId}/${remoteRef}`) ?? null,
    writeCached: async (householdId, remoteRef, bytes) => {
      const uri = `mem://${uid}/cache/${householdId}/${remoteRef}.jpg`;
      cache.set(`${householdId}/${remoteRef}`, uri);
      files.set(uri, bytes);
      return uri;
    },
  });
  client.sync = new RemoteSyncAdapter({
    baseUrl,
    getAccessToken: async () => token(uid),
    getRepos: () => client.repos,
    fetchImpl,
    pollIntervalMs: 0,
    media: client.media,
  });
  return client;
}

async function mount(client: Client): Promise<void> {
  client.repos = (await createSqliteRepositories(client.databaseName))!;
  expect(client.repos).not.toBeNull();
  client.sync = new RemoteSyncAdapter({
    baseUrl,
    getAccessToken: async () => token(client.uid),
    getRepos: () => client.repos,
    fetchImpl: async (input, init) => {
      if (!client.state.online) throw new Error('network offline');
      const response = await nodeFetch(input, init);
      if (client.state.loseNextResponse) {
        client.state.loseNextResponse = false;
        throw new Error('response lost after commit');
      }
      return response;
    },
    pollIntervalMs: 0,
    media: client.media,
  });
}

async function restart(client: Client): Promise<void> {
  await client.sync.stopSync('*');
  await closeDatabase(client.databaseName);
  client.repos = (await createSqliteRepositories(client.databaseName))!;
  await mount(client);
}

function serverCount(sql: string, ...params: any[]): number {
  return Number((store.database.prepare(sql).get(...params) as any)?.n ?? 0);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'chorescore-media-client-'));
  (globalThis as any).__CHORESCORE_SQLITE_DIR = directory;
  store = new CollaborationStore(join(directory, 'authority.sqlite'), join(directory, 'media'));
  const verifier = new FirebaseTokenVerifier('chorescore-test', async () => ({ 'test-key': publicKey }));
  server = createCollaborationServer(store, verifier);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  await closeDatabase('alice-media.db').catch(() => undefined);
  await closeDatabase('bob-media.db').catch(() => undefined);
  await closeDatabase('intruder-media.db').catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
});

test('private photos reach the other member and never leak across tenants', async () => {
  const alice = openClient('alice', 'alice-media.db');
  const bob = openClient('bob', 'bob-media.db');
  await mount(alice);
  await mount(bob);

  const { household, ownerMember, namedMembers } = await createGroupWithMembers(alice.repos, {
    name: 'Photos privées',
    owner: { userId: 'alice', displayName: 'Alice' },
    memberNames: ['Bob'],
    contributionUnit: 'points',
  });
  const bobMember = namedMembers[0];
  const hid = household.id;
  await alice.sync.ensureRemoteGroup(hid, 'alice');
  const invitation = await alice.sync.createInvitation(hid, bobMember.id);
  await bob.sync.acceptInvitation(invitation.token);

  const localRef = 'file:///alice/documents/chorescore-photos/photo-1.jpg';
  alice.files.set(localRef, new Uint8Array(photo));
  const entry = await alice.repos.contributions.create({
    householdId: hid,
    label: 'Photo du frigo',
    performedByMemberId: ownerMember.id,
    beneficiaryMemberIds: [ownerMember.id, bobMember.id],
    value: 4,
    unit: 'points',
    persistentTaskId: null,
    occurredAt: new Date().toISOString(),
    createdBy: 'alice',
    attachments: [{
      id: 'attachment-photo-1',
      kind: 'photo' as const,
      ref: localRef,
      mimeType: 'image/jpeg',
      byteSize: photo.length,
      createdAt: new Date().toISOString(),
    }],
  });

  // The authority commits the upload, then the response is lost. The durable
  // outbox retries after a full client restart with the same operation id.
  alice.state.loseNextResponse = true;
  await expect(alice.sync.pushChanges(hid)).rejects.toThrow('response lost after commit');
  // The upload may already have committed on the authority even though its
  // response was lost; the entry itself is still dirty and durable.
  expect((await alice.repos.syncState.getDirtyRecords(hid, 'contribution_entries', 0))
    .some((record) => record.id === entry.id)).toBe(true);
  await restart(alice);
  expect((await alice.repos.syncState.getDirtyRecords(hid, 'contribution_entries', 0))
    .some((record) => record.id === entry.id)).toBe(true);
  await alice.sync.pushChanges(hid);
  expect(await alice.repos.syncState.getPendingMutation(hid)).toBeNull();
  expect(serverCount('SELECT COUNT(*) AS n FROM media WHERE groupId=?', hid)).toBe(1);
  expect(serverCount(
    "SELECT COUNT(*) AS n FROM records WHERE collection='contribution_entries' AND id=?",
    entry.id,
  )).toBe(1);

  await bob.sync.pullChanges(hid);
  const remote = await bob.repos.contributions.getById(entry.id);
  const attachment = remote?.attachments?.[0];
  expect(attachment).toMatchObject({ kind: 'photo', mimeType: 'image/jpeg' });
  expect(attachment?.ref).toBe(`media:${attachment?.remoteRef}`);
  expect(attachment?.byteSize).toBe(photo.length);
  expect(attachment?.ref).not.toContain('file://');
  expect((store.database.prepare(
    "SELECT value FROM records WHERE collection='contribution_entries' AND id=?",
  ).get(entry.id) as any).value).not.toContain('file://');
  expect(attachment?.remoteRef).toMatch(/^attachment-photo-1$/);

  // Bob receives the exact bytes through the private media endpoint.
  const downloaded = await bob.media.download(hid, attachment!.remoteRef!);
  expect(Buffer.from(bob.files.get(downloaded)!)).toEqual(photo);
  // A second read is served from the private cache, not the public internet.
  expect(await bob.media.download(hid, attachment!.remoteRef!)).toBe(downloaded);

  // An unrelated authenticated account cannot read the group's private file.
  const intruder = openClient('intruder', 'intruder-media.db');
  await mount(intruder);
  await expect(intruder.media.download(hid, attachment!.remoteRef!)).rejects.toThrow(
    'Group access denied',
  );

  // Deleting while a live entry still references the file is harmless: the
  // authority keeps it (409) so no referenced object can be orphaned.
  await expect(alice.media.remove(hid, attachment!.remoteRef!)).resolves.toBeUndefined();
  expect(serverCount('SELECT COUNT(*) AS n FROM media WHERE groupId=?', hid)).toBe(1);
  // Removing the reference lets the owner delete the private object.
  await alice.repos.contributions.update(entry.id, { attachments: [] });
  await alice.sync.pushChanges(hid);
  await expect(alice.media.remove(hid, attachment!.remoteRef!)).resolves.toBeUndefined();
  bob.cache.clear();
  await expect(bob.media.download(hid, attachment!.remoteRef!)).rejects.toThrow('Media not found');
  expect(serverCount('SELECT COUNT(*) AS n FROM media WHERE groupId=?', hid)).toBe(0);

  // An interrupted local photo form never creates an authority object: the
  // outbox row is removed with the rolled-back entry and nothing is uploaded.
  const before = serverCount('SELECT COUNT(*) AS n FROM media');
  await expect(alice.repos.withTransaction(async () => {
    const draft = await alice.repos.contributions.create({
      householdId: hid,
      label: 'Brouillon',
      performedByMemberId: ownerMember.id,
      beneficiaryMemberIds: [ownerMember.id],
      value: 1,
      unit: 'points',
      persistentTaskId: null,
      occurredAt: new Date().toISOString(),
      createdBy: 'alice',
      attachments: [{
        id: 'attachment-aborted',
        kind: 'photo' as const,
        ref: (alice.files.set('file:///alice/aborted.jpg', new Uint8Array(photo)), 'file:///alice/aborted.jpg'),
        mimeType: 'image/jpeg',
        byteSize: photo.length,
        createdAt: new Date().toISOString(),
      }],
    });
    expect(draft.id).toBeTruthy();
    throw new Error('process interrupted');
  })).rejects.toThrow('process interrupted');
  await alice.sync.pushChanges(hid);
  expect(serverCount('SELECT COUNT(*) AS n FROM media')).toBe(before);
});
