/**
 * Real client <-> authority collaboration on two disk-backed SQLite clients.
 *
 * Unlike the shared in-memory client scenario, each device owns a distinct
 * database file that is closed and reopened to simulate a process restart.
 * Cursors, remote versions, pending mutation ids, conflicts and outbox rows
 * must come back from disk. A response lost after the server committed is
 * retried with the same operation id and must not create a duplicate.
 *
 * This still does not prove Firebase configuration, an Expo Android bridge or
 * two physical phones.
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
import { completeTodoAtomic } from '../src/application/use-cases/completeTodoAtomic';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';
import { adoptLocalGroups } from '../src/application/use-cases/adoptLocalGroups';
import { calculateContributionBalances } from '../src/domain/calculations/contributionLedger';

// Two real SQLite files, RSA token signing and a server restart are slower on
// the shared CI runner than the default Jest budget (observed timeout at 5 s).
jest.setTimeout(30_000);

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async (name: string) => {
    const sqlite = (process as any).getBuiltinModule('node:sqlite');
    const directory = (globalThis as any).__CHORESCORE_SQLITE_DIR as string;
    const native = new sqlite.DatabaseSync(`${directory}/${name}`);
    (globalThis as any).__CHORESCORE_NATIVES ??= {};
    (globalThis as any).__CHORESCORE_NATIVES[name] = native;
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
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? 'GET',
      headers,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => body,
        } as Response);
      });
    });
    req.on('error', reject);
    init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')));
    if (init?.body) req.write(init.body);
    req.end();
  });
}

let directory: string;
let store: CollaborationStore;
let server: ReturnType<typeof createCollaborationServer>;
let port: number;
let baseUrl: string;

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(port ?? 0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'chorescore-sqlite-collab-'));
  (globalThis as any).__CHORESCORE_SQLITE_DIR = directory;
  store = new CollaborationStore(join(directory, 'authority.sqlite'));
  const verifier = new FirebaseTokenVerifier('chorescore-test', async () => ({ 'test-key': publicKey }));
  server = createCollaborationServer(store, verifier);
  await listen();
});

afterAll(async () => {
  await stopServer();
  await closeDatabase('alice.db').catch(() => undefined);
  await closeDatabase('bob.db').catch(() => undefined);
  await closeDatabase('carol.db').catch(() => undefined);
  await closeDatabase('dave.db').catch(() => undefined);
  await closeDatabase('completion-a.db').catch(() => undefined);
  await closeDatabase('completion-b.db').catch(() => undefined);
  await closeDatabase('recovery.db').catch(() => undefined);
  await closeDatabase('adopt-a.db').catch(() => undefined);
  await closeDatabase('adopt-b.db').catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
});

interface Client {
  repos: AllRepositories;
  sync: RemoteSyncAdapter;
  uid: string;
  databaseName: string;
  online: boolean;
  loseNextResponse: boolean;
}

function createSync(client: Omit<Client, 'sync'>): RemoteSyncAdapter {
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!client.online) throw new Error('network offline');
    const response = await nodeFetch(input, init);
    if (client.loseNextResponse) {
      client.loseNextResponse = false;
      throw new Error('response lost after commit');
    }
    return response;
  };
  return new RemoteSyncAdapter({
    baseUrl,
    getAccessToken: async () => token(client.uid),
    getRepos: () => client.repos,
    fetchImpl,
    pollIntervalMs: 0,
  });
}

async function openClient(uid: string, databaseName: string): Promise<Client> {
  const repos = (await createSqliteRepositories(databaseName))!;
  expect(repos).not.toBeNull();
  const client: Client = {
    repos,
    sync: null as unknown as RemoteSyncAdapter,
    uid,
    databaseName,
    online: true,
    loseNextResponse: false,
  };
  client.sync = createSync(client);
  return client;
}

async function restart(client: Client): Promise<void> {
  await client.sync.stopSync('*');
  await closeDatabase(client.databaseName);
  client.repos = (await createSqliteRepositories(client.databaseName))!;
  client.sync = createSync(client);
}

function serverCount(sql: string, ...params: any[]): number {
  return Number((store.database.prepare(sql).get(...params) as any)?.n ?? 0);
}

test('two restarted SQLite clients keep cursors, outbox, conflicts and exact ledgers', async () => {
  const alice = await openClient('alice', 'alice.db');
  const bob = await openClient('bob', 'bob.db');

  const { household, ownerMember, namedMembers } = await createGroupWithMembers(alice.repos, {
    name: 'Maison SQLite',
    owner: { userId: 'alice', displayName: 'Alice' },
    memberNames: ['Bob'],
    contributionUnit: 'points',
  });
  const bobMember = namedMembers[0];
  const hid = household.id;

  await alice.sync.ensureRemoteGroup(hid, 'alice');
  const invitation = await alice.sync.createInvitation(hid, bobMember.id);
  await bob.sync.acceptInvitation(invitation.token);

  expect(await bob.repos.households.getById(hid)).toMatchObject({
    id: hid,
    name: 'Maison SQLite',
    contributionUnit: 'points',
  });
  expect(await bob.repos.members.getById(bobMember.id)).toMatchObject({
    id: bobMember.id,
    name: 'Bob',
    userId: 'bob',
  });

  const entry = await alice.repos.contributions.create({
    householdId: hid,
    label: 'Cuisine durable',
    performedByMemberId: ownerMember.id,
    beneficiaryMemberIds: [ownerMember.id, bobMember.id],
    value: 10,
    unit: 'points',
    persistentTaskId: null,
    occurredAt: new Date().toISOString(),
    createdBy: 'alice',
  });
  await alice.sync.pushChanges(hid);
  await bob.sync.pullChanges(hid);
  expect(calculateContributionBalances(await bob.repos.contributions.getByHousehold(hid), 'points'))
    .toEqual(calculateContributionBalances(await alice.repos.contributions.getByHousehold(hid), 'points'));

  // Restart both clients. Cursors, server versions and entities must reopen
  // from their own files; startSync must not re-upload or duplicate anything.
  const bobCursor = (await bob.repos.syncState.getGroupState(hid))?.lastRevision;
  const aliceCursor = (await alice.repos.syncState.getGroupState(hid))?.lastRevision;
  await restart(alice);
  await restart(bob);
  expect((await bob.repos.syncState.getGroupState(hid))?.lastRevision).toBe(bobCursor);
  expect((await alice.repos.syncState.getGroupState(hid))?.lastRevision).toBe(aliceCursor);
  expect(await bob.repos.contributions.getById(entry.id)).toMatchObject({ label: 'Cuisine durable' });
  await bob.sync.startSync(hid);
  await alice.sync.startSync(hid);
  expect(await alice.repos.contributions.getByHousehold(hid)).toHaveLength(1);
  expect(await bob.repos.contributions.getByHousehold(hid)).toHaveLength(1);
  expect(serverCount('SELECT COUNT(*) AS n FROM events WHERE groupId=?', hid)).toBeGreaterThan(0);

  // The authority commits but the response never reaches Alice. The durable
  // pending operation is retried after a process restart with the same id.
  const expense = await alice.repos.expenses.create({
    householdId: hid,
    title: 'Courses perdues',
    amountMinor: 250,
    currency: 'CHF',
    paidByMemberId: ownerMember.id,
    participantMemberIds: [ownerMember.id, bobMember.id],
    splitMode: 'equal',
    occurredAt: new Date().toISOString(),
    createdBy: 'alice',
  });
  alice.loseNextResponse = true;
  await expect(alice.sync.pushChanges(hid)).rejects.toThrow('response lost after commit');
  expect(await alice.repos.syncState.getPendingMutation(hid)).not.toBeNull();
  expect(serverCount(
    "SELECT COUNT(*) AS n FROM records WHERE collection='expense_entries' AND id=? AND value IS NOT NULL",
    expense.id,
  )).toBe(1);
  await restart(alice);
  expect(await alice.repos.syncState.getPendingMutation(hid)).not.toBeNull();
  await alice.sync.pushChanges(hid);
  expect(await alice.repos.syncState.getPendingMutation(hid)).toBeNull();
  expect(serverCount(
    "SELECT COUNT(*) AS n FROM records WHERE collection='expense_entries' AND id=? AND value IS NOT NULL",
    expense.id,
  )).toBe(1);
  expect(serverCount(
    'SELECT COUNT(*) AS n FROM events WHERE groupId=? AND changes LIKE ?',
    hid,
    `%${expense.id}%`,
  )).toBe(1);
  await bob.sync.pullChanges(hid);
  expect((await bob.repos.expenses.getByHousehold(hid)).filter((row) => row.id === expense.id)).toHaveLength(1);

  // An offline deletion is a durable tombstone that survives a restart and
  // reaches the other client; it must not be recreated by a later pull.
  bob.online = false;
  await bob.repos.expenses.delete(expense.id);
  await restart(bob);
  expect(await bob.repos.expenses.getById(expense.id)).toBeNull();
  const tombstones = (await bob.repos.syncState.getDirtyRecords(hid, 'expense_entries', 0))
    .filter((record) => record.id === expense.id);
  expect(tombstones).toHaveLength(1);
  expect(tombstones[0].deletedAt).toEqual(expect.any(String));
  bob.online = true;
  await bob.sync.startSync(hid);
  await alice.sync.pullChanges(hid);
  expect(await alice.repos.expenses.getById(expense.id)).toBeNull();
  expect((store.database.prepare(
    "SELECT value FROM records WHERE collection='expense_entries' AND id=?",
  ).get(expense.id) as any).value).toBeNull();

  // An interrupted transaction leaves neither business data nor an outbox row.
  let interruptedId = '';
  const before = await bob.repos.contributions.getByHousehold(hid);
  await expect(bob.repos.withTransaction(async () => {
    const created = await bob.repos.contributions.create({
      householdId: hid,
      label: 'Jamais commité',
      performedByMemberId: bobMember.id,
      beneficiaryMemberIds: [ownerMember.id, bobMember.id],
      value: 3,
      unit: 'points',
      persistentTaskId: null,
      occurredAt: new Date().toISOString(),
      createdBy: 'bob',
    });
    interruptedId = created.id;
    throw new Error('process interrupted');
  })).rejects.toThrow('process interrupted');
  expect(await bob.repos.contributions.getByHousehold(hid)).toEqual(before);
  expect(await bob.repos.contributions.getById(interruptedId)).toBeNull();
  expect((await bob.repos.syncState.getDirtyRecords(hid, 'contribution_entries', 0))
    .some((record) => record.id === interruptedId)).toBe(false);

  // Two devices complete the same todo at the same time. The authority owns
  // the atomic transition, so exactly one ledger entry exists.
  const todo = await alice.repos.todos.create({
    householdId: hid,
    title: 'Une seule complétion',
    kind: 'task',
    status: 'todo',
    assigneeMemberId: ownerMember.id,
    beneficiaryMemberIds: [ownerMember.id, bobMember.id],
    dueAt: null,
    reminderAt: null,
    notes: '',
    persistentTaskId: null,
  });
  await alice.sync.pushChanges(hid);
  await bob.sync.pullChanges(hid);
  const completion = {
    performerMemberId: ownerMember.id,
    value: 4,
    beneficiaryMemberIds: [ownerMember.id, bobMember.id],
    categoryId: null,
    note: 'atomique',
  };
  const outcomes = await Promise.allSettled([
    alice.sync.completeTodo!(hid, todo.id, { ...completion, completedByUserId: 'alice' }),
    bob.sync.completeTodo!(hid, todo.id, { ...completion, completedByUserId: 'bob' }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  expect(serverCount(
    "SELECT COUNT(*) AS n FROM records WHERE collection='contribution_entries' AND id LIKE 'todo-%'",
  )).toBe(1);
  await alice.sync.pullChanges(hid);
  await bob.sync.pullChanges(hid);
  expect(await alice.repos.todos.getById(todo.id)).toMatchObject({ status: 'completed' });
  expect(await bob.repos.todos.getById(todo.id)).toMatchObject({ status: 'completed' });
  expect(await alice.repos.contributions.getByHousehold(hid)).toHaveLength(2);
  expect(await bob.repos.contributions.getByHousehold(hid)).toHaveLength(2);
});

test('a revoked targeted invitation cannot link, and a fresh one keeps the same member id', async () => {
  const carol = await openClient('carol', 'carol.db');
  const dave = await openClient('dave', 'dave.db');

  const { household, namedMembers } = await createGroupWithMembers(carol.repos, {
    name: 'Invitations révoquées',
    owner: { userId: 'carol', displayName: 'Carol' },
    memberNames: ['Dave'],
    contributionUnit: 'minutes',
  });
  const daveMember = namedMembers[0];
  const hid = household.id;
  await carol.sync.ensureRemoteGroup(hid, 'carol');

  const revoked = await carol.sync.createInvitation(hid, daveMember.id);
  await carol.sync.revokeInvitation(hid, revoked.token);
  await expect(dave.sync.acceptInvitation(revoked.token)).rejects.toThrow('Invitation unavailable');
  expect(await dave.repos.members.getById(daveMember.id)).toBeNull();

  const fresh = await carol.sync.createInvitation(hid, daveMember.id);
  const accepted = await dave.sync.acceptInvitation(fresh.token);
  expect(accepted).toEqual({ groupId: hid, memberId: daveMember.id });
  expect(await dave.repos.members.getById(daveMember.id)).toMatchObject({
    id: daveMember.id,
    name: 'Dave',
    userId: 'dave',
  });
  expect(await dave.repos.members.getByHousehold(hid)).toHaveLength(2);
  expect((await carol.repos.members.getByHousehold(hid)).filter((m) => m.name === 'Dave')).toHaveLength(1);

  await dave.sync.stopSync('*');
  await carol.sync.stopSync('*');
});

test('a batch boundary keeps unsent changes durable across restart and reaches the other SQLite client', async () => {
  const alice = await openClient('alice', 'alice.db');
  const bob = await openClient('bob', 'bob.db');
  const { household, namedMembers } = await createGroupWithMembers(alice.repos, {
    name: 'Deux lots persistants', owner: { userId: 'alice', displayName: 'Alice' },
    memberNames: ['Bob'], contributionUnit: 'points',
  });
  const hid = household.id;
  await alice.sync.ensureRemoteGroup(hid, alice.uid);
  const invitation = await alice.sync.createInvitation(hid, namedMembers[0].id);
  await bob.sync.acceptInvitation(invitation.token);
  await alice.sync.pushChanges(hid);
  expect((await alice.sync.getStatus(hid)).pendingChanges).toBe(0);
  for (let index = 0; index < 121; index++) {
    await alice.repos.categories.create({ householdId: hid, name: `Lot ${index}`, defaultTaskRatio: null });
  }
  await alice.sync.pushChanges(hid);
  const remoteCount = () => serverCount("SELECT COUNT(*) AS n FROM records WHERE groupId=? AND collection='categories'", hid);
  expect(remoteCount()).toBe(100);
  expect((await alice.sync.getStatus(hid)).pendingChanges).toBe(21);
  await restart(alice);
  expect((await alice.sync.getStatus(hid)).pendingChanges).toBe(21);
  await alice.sync.pushChanges(hid);
  expect(remoteCount()).toBe(121);
  expect((await alice.sync.getStatus(hid)).pendingChanges).toBe(0);
  await bob.sync.pullChanges(hid);
  const received = await bob.repos.categories.getByHousehold(hid);
  expect(received).toHaveLength(121);
  expect(new Set(received.map(category => category.name)).size).toBe(121);
  await alice.sync.pushChanges(hid);
  expect(remoteCount()).toBe(121);
});


test('offline group adopted by Google reaches a second SQLite client without recreating members or ledgers', async () => {
  const a = await openClient('adopt-a', 'adopt-a.db');
  const b = await openClient('adopt-b', 'adopt-b.db');
  const localId = 'local-before-google';
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(a.repos, {
    name: 'Créé sans compte', owner: { userId: localId, displayName: 'Moi' },
    memberNames: ['Bob'], contributionUnit: 'points',
  });
  const hid = household.id;
  const ids = [ownerMember.id, namedMembers[0].id];
  const todo = await a.repos.todos.create({ householdId: hid, title: 'Payé avant Google', kind: 'expense',
    status: 'todo', assigneeMemberId: ids[0], beneficiaryMemberIds: ids,
    dueAt: null, reminderAt: null, notes: 'Origine locale', persistentTaskId: null });
  await completeTodoAtomic(a.repos, { todo, household, paidByMemberId: ids[0], amountMinor: 101,
    currency: 'CHF', participantMemberIds: ids, completedByUserId: localId });
  const oldEntry = (await a.repos.expenses.getByHousehold(hid))[0];
  await adoptLocalGroups(a.repos, { getItem: async () => localId, setItem: async () => {},
    deleteItem: async () => {}, clear: async () => {} }, a.uid, () => a.uid);
  await restart(a);
  await a.sync.pushChanges(hid);
  const invitation = await a.sync.createInvitation(hid, ids[1]);
  await b.sync.acceptInvitation(invitation.token);
  await b.sync.pullChanges(hid);
  expect(await b.repos.members.getByHousehold(hid)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: ids[0], userId: a.uid }), expect.objectContaining({ id: ids[1], userId: b.uid }),
  ]));
  expect(await b.repos.members.getByHousehold(hid)).toHaveLength(2);
  expect(await b.repos.expenses.getByHousehold(hid)).toEqual([expect.objectContaining({
    id: oldEntry.id, amountMinor: 101, currency: 'CHF', paidByMemberId: ids[0],
    participantMemberIds: ids, createdBy: a.uid,
  })]);
  expect(await b.repos.todos.getById(todo.id)).toMatchObject({ status: 'completed' });
  expect((await a.sync.getStatus(hid)).conflicts).toBe(0);
});

test('ordinary HTTP outbox synchronizes both local todo completions with their new category', async () => {
  const a = await openClient('completion-a', 'completion-a.db');
  const b = await openClient('completion-b', 'completion-b.db');
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(a.repos, {
    name: 'Complétions locales', owner: { userId: a.uid, displayName: 'Alice' },
    memberNames: ['Bob'], contributionUnit: 'points',
  });
  const hid = household.id;
  const ids = [ownerMember.id, namedMembers[0].id];
  await a.sync.ensureRemoteGroup(hid, a.uid);
  const invitation = await a.sync.createInvitation(hid, ids[1]);
  await b.sync.acceptInvitation(invitation.token);
  const category = await a.repos.categories.create({ householdId: hid, name: 'Nouvelle catégorie', defaultTaskRatio: null });
  for (const kind of ['task', 'expense'] as const) {
    const todo = await a.repos.todos.create({ householdId: hid, title: `Local ${kind}`, kind, status: 'todo',
      assigneeMemberId: ids[0], beneficiaryMemberIds: ids, dueAt: null, reminderAt: null, notes: 'Prévue',
      persistentTaskId: null, categoryId: category.id });
    if (kind === 'task') {
      await completeTodoAtomic(a.repos, { todo, household, performerMemberId: ids[0], value: 3,
        beneficiaryMemberIds: ids, completedByUserId: a.uid });
    } else {
      await completeTodoAtomic(a.repos, { todo, household, paidByMemberId: ids[0], amountMinor: 201, currency: 'CHF',
        participantMemberIds: ids, completedByUserId: a.uid });
    }
  }
  await restart(a);
  await a.sync.pushChanges(hid);
  await b.sync.pullChanges(hid);
  expect((await b.repos.todos.getByHousehold(hid)).map(todo => todo.status)).toEqual(['completed', 'completed']);
  expect(await b.repos.contributions.getByHousehold(hid)).toEqual([expect.objectContaining({ value: 3, categoryId: category.id })]);
  expect(await b.repos.expenses.getByHousehold(hid)).toEqual([expect.objectContaining({ amountMinor: 201, categoryId: category.id })]);
  const projection=await b.repos.balanceProjections.getByHousehold(hid,'points',ids);
  expect(projection.contribution).toEqual(new Map([[ids[0],1.5],[ids[1],-1.5]]));
  expect(projection.moneyByCurrency.get('CHF')).toEqual(new Map([[ids[0],100],[ids[1],-100]]));
  await a.sync.pushChanges(hid);
  expect(await b.repos.categories.getByHousehold(hid)).toHaveLength(1);
  expect(serverCount('SELECT COUNT(*) AS n FROM records WHERE groupId=? AND collection IN (?,?)', hid, 'contribution_entries', 'expense_entries')).toBe(2);
});


test('lost group-creation response survives restart without conflicts or dropping offline settings and members', async () => {
  const a = await openClient('recovery', 'recovery.db');
  const { household, namedMembers } = await createGroupWithMembers(a.repos, {
    name: 'Création interrompue', owner: { userId: a.uid, displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  const hid = household.id;
  a.loseNextResponse = true;
  await expect(a.sync.ensureRemoteGroup(hid, a.uid)).rejects.toThrow('response lost');
  const rate = { contributionValue: 2, contributionUnit: 'points' as const, moneyAmountMinor: 150, currency: 'CHF' };
  await a.repos.households.update(hid, { name: 'Renommé hors ligne', crossLedgerCompensationEnabled: true, contributionToMoneyRate: rate });
  await a.repos.members.update(namedMembers[0].id, { name: 'Robert' });
  const added = await a.repos.members.create({ householdId: hid, name: 'Charlie', userId: null });
  await restart(a);
  await a.sync.startSync(hid);
  const status = await a.sync.getStatus(hid);
  expect(status.conflicts).toBe(0);
  expect(status.pendingChanges).toBe(0);
  const remote = store.listGroups(a.uid).find(group => group.household.id === hid)!;
  expect(remote.household).toMatchObject({ name: 'Renommé hors ligne', contributionToMoneyRate: rate });
  const events = store.deltas(a.uid, hid, 0).events.flatMap(event => event.changes);
  expect(events.findLast((change: any) => change.id === namedMembers[0].id).value.name).toBe('Robert');
  expect(events.find((change: any) => change.id === added.id).value.name).toBe('Charlie');
});

test('a reusable shortcut is shared between two real SQLite clients and its deletion keeps past tasks', async () => {
  const { saveTaskShortcut } = require('../src/application/use-cases/taskShortcuts');
  const alice = await openClient('shortcut-alice', 'shortcut-alice.db');
  const bob = await openClient('shortcut-bob', 'shortcut-bob.db');
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(alice.repos, {
    name: 'Raccourcis partagés', owner: { userId: alice.uid, displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points' });
  await alice.sync.ensureRemoteGroup(household.id, alice.uid);
  const invitation = await alice.sync.createInvitation(household.id, namedMembers[0].id);
  await bob.sync.acceptInvitation(invitation.token);
  const shortcut = await saveTaskShortcut(alice.repos, { householdId: household.id, name: 'Cuisine', value: '3,5', unit: 'points', beneficiaryMemberIds: [ownerMember.id, namedMembers[0].id] });
  await alice.sync.pushChanges(household.id); await bob.sync.pullChanges(household.id);
  expect(await bob.repos.tasks.getById(shortcut.id)).toEqual(shortcut);
  const entry = await bob.repos.contributions.create({ householdId: household.id, label: shortcut.name, value: shortcut.defaultValue,
    unit: shortcut.defaultUnit, performedByMemberId: namedMembers[0].id, beneficiaryMemberIds: shortcut.defaultBeneficiaryMemberIds!,
    persistentTaskId: shortcut.id, occurredAt: new Date().toISOString(), createdBy: bob.uid });
  await bob.sync.pushChanges(household.id); await alice.sync.pullChanges(household.id);
  await alice.repos.tasks.delete(shortcut.id);
  await alice.sync.pushChanges(household.id); await bob.sync.pullChanges(household.id);
  await restart(bob);
  expect(await bob.repos.tasks.getById(shortcut.id)).toBeNull();
  expect(await bob.repos.contributions.getById(entry.id)).toEqual(entry);
});
