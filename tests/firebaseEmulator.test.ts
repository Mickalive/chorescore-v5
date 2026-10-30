/**
 * Real Firestore emulator journey.
 *
 * This test talks to the official Firestore emulator over its REST API with
 * the candidate `firebase/firestore.rules` loaded. It uses the production
 * `FirestoreRestClient`, `FirebaseSyncTransport`, `RemoteSyncAdapter` and
 * `FirebaseMediaGateway`; no InMemoryFirestore or deployed project is used.
 *
 * Run this file locally inside `firebase emulators:exec`, which
 * supplies FIRESTORE_EMULATOR_HOST. A plain local `npm test` skips it because
 * there is no emulator to prove anything.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteRepositories,
  AllRepositories,
} from '../src/infrastructure/repositories/RepositoryFactory';
import { closeDatabase } from '../src/infrastructure/local/SqliteStorage';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';
import { FirebaseSyncTransport } from '../src/infrastructure/firebase/FirebaseSyncTransport';
import { FirebaseMediaGateway } from '../src/infrastructure/firebase/FirebaseMediaGateway';
import { FirestoreRestClient } from '../src/infrastructure/firebase/FirestoreRestClient';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';
import { completeTodoAtomic } from '../src/application/use-cases/completeTodoAtomic';
import { todoCompletionEntryId } from '../src/domain/services/todoCompletionId';

let mockDirectory: string;
const databases = new Set<string>();
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async (name: string) => {
    const sqlite = (process as any).getBuiltinModule('node:sqlite');
    const database = new sqlite.DatabaseSync(`${mockDirectory}/${name}`);
    return {
      execAsync: async (sql: string) => database.exec(sql),
      runAsync: async (sql: string, ...args: any[]) => database.prepare(sql).run(...(Array.isArray(args[0]) ? args[0] : args)),
      getAllAsync: async (sql: string, ...args: any[]) => database.prepare(sql).all(...(Array.isArray(args[0]) ? args[0] : args)),
      getFirstAsync: async (sql: string, ...args: any[]) => database.prepare(sql).get(...(Array.isArray(args[0]) ? args[0] : args)) ?? null,
      closeAsync: async () => database.close(),
      withTransactionAsync: async (fn: () => Promise<void>) => {
        database.exec('BEGIN');
        try { await fn(); database.exec('COMMIT'); }
        catch (error) { database.exec('ROLLBACK'); throw error; }
      },
    };
  },
}));

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
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => text,
            json: async () => JSON.parse(text),
          } as Response);
        });
      },
    );
    request.on('error', reject);
    if (init.signal) {
      init.signal.addEventListener('abort', () => request.destroy(new Error('Aborted')));
    }
    if (init.body !== undefined && init.body !== null) request.write(init.body as string);
    request.end();
  });
}

function emulatorFetch(fail: { next: boolean; loseCommitResponse: boolean }): typeof fetch {
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
    const response = await nodeFetch(url, init);
    if (response.ok && url.pathname.endsWith(':commit') && fail.loseCommitResponse) {
      fail.loseCommitResponse = false;
      throw new Error('commit response lost');
    }
    return response;
  }) as typeof fetch;
}

interface Client {
  databaseName: string;
  uid: string;
  repos: AllRepositories;
  sync: RemoteSyncAdapter;
  media: FirebaseMediaGateway;
  transport: FirebaseSyncTransport;
  firestore: FirestoreRestClient;
  cache: Map<string, Uint8Array>;
  fail: { next: boolean; loseCommitResponse: boolean };
}

async function client(uid: string): Promise<Client> {
  const fail = { next: false, loseCommitResponse: false };
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
  const databaseName = `${uid}.db`;
  databases.add(databaseName);
  const repos = await createSqliteRepositories(databaseName);
  if (!repos) throw new Error('The Firebase journey requires a real SQLite database');
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
  let result: Client;
  const sync = new RemoteSyncAdapter({
    request: (method, path, body) => transport.request(method, path, body),
    getAccessToken,
    getRepos: () => result.repos,
    media,
    pollIntervalMs: 0,
  });
  result = { uid, databaseName, repos, sync, media, transport, firestore, cache, fail };
  return result;
}

async function restart(target: Client): Promise<void> {
  await target.sync.stopSync('*');
  await closeDatabase(target.databaseName);
  const repos = await createSqliteRepositories(target.databaseName);
  if (!repos) throw new Error('Failed to reopen SQLite');
  target.repos = repos;
  target.sync = new RemoteSyncAdapter({
    request: (method, path, body) => target.transport.request(method, path, body),
    getAccessToken: async () => token(target.uid),
    getRepos: () => target.repos,
    media: target.media,
    pollIntervalMs: 0,
  });
}

async function householdRevision(target: Client, householdId: string): Promise<number> {
  const document = await target.firestore.getDocument(`groups/${householdId}`);
  return Number(document?.fields.revision ?? 0);
}

describeEmulator('real Firestore rules and collaboration journey', () => {
  jest.setTimeout(120_000);
  beforeAll(() => { mockDirectory = mkdtempSync(join(tmpdir(), 'chorescore-firestore-sqlite-')); });
  afterAll(async () => {
    for (const name of databases) await closeDatabase(name);
    rmSync(mockDirectory, { recursive: true, force: true });
  });

  test('two accounts, targeted invitation, real deltas, media and owner deletion', async () => {
    const suffix = randomUUID().slice(0, 8);
    const alice = await client(`alice-${suffix}`);
    const bob = await client(`bob-${suffix}`);
    const mallory = await client(`mallory-${suffix}`);

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
    await restart(bob);
    expect(await bob.repos.contributions.getById(entry.id)).toMatchObject({ value: 10 });
    expect((await bob.repos.members.getByHousehold(hid)).map(member => member.id)).toContain(bobMember.id);

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
    const pending = await bob.repos.syncState.getPendingMutation(hid);
    expect(pending).not.toBeNull();
    await restart(bob);
    expect(await bob.repos.syncState.getPendingMutation(hid)).toEqual(pending);
    // The authority commits, but the phone never receives the acknowledgement.
    // Restart again before retrying: only the durable operation id may dedupe it.
    bob.fail.loseCommitResponse = true;
    await expect(bob.sync.pushChanges(hid)).rejects.toThrow('commit response lost');
    const committedRevision = await householdRevision(alice, hid);
    await restart(bob);
    await bob.sync.pushChanges(hid);
    expect(await householdRevision(alice, hid)).toBe(committedRevision);
    await alice.sync.pullChanges(hid);
    expect(await alice.repos.categories.getById(bobCategory.id)).toMatchObject({
      name: `Bob ${suffix}`,
    });

    for (const kind of ['task', 'expense'] as const) {
      const todo = await alice.repos.todos.create({
        householdId: hid, title: `Offline ${kind}`, kind, status: 'todo',
        assigneeMemberId: bobMember.id, beneficiaryMemberIds: [ownerMember.id, bobMember.id],
        dueAt: null, reminderAt: null, notes: '', persistentTaskId: null,
      });
      await alice.sync.pushChanges(hid);
      // A completed status without its deterministic ledger row stays invalid.
      await expect(alice.transport.request('POST', `/groups/${hid}/mutations`, {
        operationId: `bad-complete-${kind}-${suffix}`,
        changes: [{ collection: 'todo_items', id: todo.id, baseVersion: 1,
          value: { ...todo, status: 'completed', completedAt: new Date(clock).toISOString() } }],
      })).rejects.toThrow('atomic completion');
      await bob.sync.pullChanges(hid);
      const received = (await bob.repos.todos.getById(todo.id))!;
      await completeTodoAtomic(bob.repos, kind === 'task'
        ? { todo: received, household, completedByUserId: bob.uid,
            performerMemberId: bobMember.id, beneficiaryMemberIds: [ownerMember.id, bobMember.id], value: 6 }
        : { todo: received, household, completedByUserId: bob.uid,
            paidByMemberId: bobMember.id, participantMemberIds: [ownerMember.id, bobMember.id], amountMinor: 101, currency: 'CHF' });
      await restart(bob);
      await bob.sync.pushChanges(hid);
      await alice.sync.pullChanges(hid);
      expect(await alice.repos.todos.getById(todo.id)).toMatchObject({ status: 'completed' });
      const ledger = kind === 'task' ? alice.repos.contributions : alice.repos.expenses;
      expect(await ledger.getById(await todoCompletionEntryId(todo.id))).not.toBeNull();
      // Bypass the mobile transport: keeping status='completed' must not let
      // another direct client silently rewrite an already completed todo.
      const todoPath = `groups/${hid}/records/todo_items:${todo.id}`;
      const completedRecord = await alice.firestore.getDocument(todoPath);
      if (!completedRecord) throw new Error('Completed todo must exist before attacking it');
      for (const patch of [{ title: 'Forged completed title' }, { status: 'todo' }, null]) {
        await expect(alice.firestore.runTransaction(async transaction => {
          const group = await transaction.get(`groups/${hid}`);
          if (!group) throw new Error('Missing group');
          const nextRevision = Number(group.fields.revision) + 1;
          const value = patch === null ? null : { ...(completedRecord.fields.value as Record<string, any>), ...patch };
          transaction.set(`groups/${hid}`, { ...group.fields, revision: nextRevision });
          transaction.set(todoPath, { ...completedRecord.fields, revision: nextRevision,
            version: Number(completedRecord.fields.version) + 1, value });
          transaction.set(`groups/${hid}/events/${nextRevision}`, { revision: nextRevision,
            groupId: hid, count: 1, createdAt: new Date(clock).toISOString() });
          transaction.set(`groups/${hid}/events/${nextRevision}/changes/0`, { revision: nextRevision,
            index: 0, collection: 'todo_items', id: todo.id,
            version: Number(completedRecord.fields.version) + 1, value });
        })).rejects.toMatchObject({ status: 403 });
        expect(await alice.firestore.getDocument(todoPath)).toEqual(completedRecord);
      }
      const revision = await householdRevision(alice, hid);
      await bob.sync.pushChanges(hid);
      expect(await householdRevision(alice, hid)).toBe(revision);
    }

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
  test('direct Firestore clients cannot rewrite a settlement or forge its author, rate or converted amount', async () => {
    const suffix=randomUUID().slice(0,8);
    const alice=await client(`settlement-owner-${suffix}`);
    const {household,ownerMember,namedMembers}=await createGroupWithMembers(alice.repos,{
      name:`Compensation ${suffix}`,owner:{userId:alice.uid,displayName:'Alice'},memberNames:['Bob'],contributionUnit:'points'});
    const rate={contributionValue:1,contributionUnit:'points' as const,moneyAmountMinor:100,currency:'CHF'};
    await alice.repos.households.update(household.id,{crossLedgerCompensationEnabled:true,contributionToMoneyRate:rate});
    await alice.sync.ensureRemoteGroup(household.id,alice.uid);
    const ids=[ownerMember.id,namedMembers[0].id];
    await alice.repos.contributions.create({householdId:household.id,label:'Travail',value:10,unit:'points',performedByMemberId:ids[0],
      beneficiaryMemberIds:ids,persistentTaskId:null,occurredAt:new Date().toISOString(),createdBy:alice.uid});
    await alice.repos.expenses.create({householdId:household.id,title:'Avance',amountMinor:1000,currency:'CHF',paidByMemberId:ids[1],
      participantMemberIds:ids,splitMode:'equal',occurredAt:new Date().toISOString(),createdBy:alice.uid});
    await alice.sync.pushChanges(household.id);
    const settlement=await alice.repos.settlements.create({householdId:household.id,contributionCreditorMemberId:ids[0],counterpartyMemberId:ids[1],
      contributionValue:3,contributionUnit:'points',moneyAmountMinor:300,currency:'CHF',rateSnapshot:rate,occurredAt:new Date().toISOString(),createdBy:alice.uid});
    await alice.sync.pushChanges(household.id);
    const path=`groups/${household.id}/records/settlements:${settlement.id}`;
    const original=await alice.firestore.getDocument(path);
    if(!original)throw new Error('The valid settlement must actually commit before the hostile tests');
    const attack=async(id:string,patch:Record<string,unknown>,existing=false)=>alice.firestore.runTransaction(async transaction=>{
      const group=await transaction.get(`groups/${household.id}`);
      if(!group)throw new Error('Group missing');
      const revision=Number(group.fields.revision)+1;
      transaction.set(`groups/${household.id}`,{...group.fields,revision});
      transaction.set(`groups/${household.id}/records/settlements:${id}`,{...original.fields,id,revision,version:existing?Number(original.fields.version)+1:1,
        value:{...(original.fields.value as Record<string,any>),id,...patch} as any});
    });
    await expect(attack(settlement.id,{moneyAmountMinor:301},true)).rejects.toMatchObject({status:403});
    await expect(attack(`forged-author-${suffix}`,{createdBy:'another-account'})).rejects.toMatchObject({status:403});
    await expect(attack(`forged-rate-${suffix}`,{rateSnapshot:{...rate,moneyAmountMinor:500}})).rejects.toMatchObject({status:403});
    await expect(attack(`forged-amount-${suffix}`,{moneyAmountMinor:999})).rejects.toMatchObject({status:403});
    expect(await alice.firestore.getDocument(path)).toEqual(original);
  });

});
