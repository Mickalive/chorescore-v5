/**
 * Real client <-> authority collaboration test.
 *
 * Two independent local repository sets talk to the real HTTP/SQLite server
 * through RemoteSyncAdapter with signed test identities. This exercises the
 * same adapter used by the app (durable outbox, revision cursors, tombstones,
 * targeted invitations, conflict retention and offline retry). It does not
 * prove a Firebase deployment, two physical phones or private media storage.
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
  createInMemoryRepositories,
  AllRepositories,
} from '../src/infrastructure/repositories/RepositoryFactory';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';
import { addGroupMember, createGroupWithMembers, renameGroupMember } from '../src/application/use-cases/groupMembers';
import { calculateContributionBalances } from '../src/domain/calculations/contributionLedger';
import { calculateFinancialBalances } from '../src/domain/calculations/expenseLedger';

jest.setTimeout(30_000);

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

// jest-expo replaces global fetch with the Expo native implementation.
// Keep this integration test on Node's real HTTP stack instead.
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
  directory = mkdtempSync(join(tmpdir(), 'chorescore-client-collab-'));
  store = new CollaborationStore(join(directory, 'authority.sqlite'));
  const verifier = new FirebaseTokenVerifier('chorescore-test', async () => ({ 'test-key': publicKey }));
  server = createCollaborationServer(store, verifier);
  await listen();
});

afterAll(async () => {
  await stopServer();
  rmSync(directory, { recursive: true, force: true });
});

interface Client {
  repos: AllRepositories;
  sync: RemoteSyncAdapter;
  uid: string;
  online: boolean;
}

function client(uid: string, repos = createInMemoryRepositories()): Client {
  const state: Client = {
    repos,
    uid,
    online: true,
    sync: null as unknown as RemoteSyncAdapter,
  };
  const fetchImpl: typeof fetch = (input, init) =>
    state.online
      ? nodeFetch(input, init)
      : Promise.reject(new Error('network offline'));
  state.sync = new RemoteSyncAdapter({
    baseUrl,
    getAccessToken: async () => token(state.uid),
    getRepos: () => state.repos,
    fetchImpl,
    pollIntervalMs: 0,
  });
  return state;
}

async function pushAndPull(source: Client, target: Client, householdId: string): Promise<void> {
  await source.sync.pushChanges(householdId);
  await target.sync.pullChanges(householdId);
}

test('two independent clients share exact ledgers, targeted member links, conflicts and offline recovery', async () => {
  const alice = client('alice');
  const bob = client('bob');
  const mallory = client('mallory');

  const { household, ownerMember, namedMembers } = await createGroupWithMembers(alice.repos, {
    name: 'Maison partagée',
    owner: { userId: 'alice', displayName: 'Alice' },
    memberNames: ['Bob'],
    contributionUnit: 'points',
  });
  const bobMember = namedMembers[0];
  const hid = household.id;

  await alice.sync.ensureRemoteGroup(hid, 'alice');
  const invitation = await alice.sync.createInvitation(hid, bobMember.id);
  await bob.sync.acceptInvitation(invitation.token);

  const bobHousehold = await bob.repos.households.getById(hid);
  expect(bobHousehold).toMatchObject({ id: hid, name: 'Maison partagée', contributionUnit: 'points' });
  const linkedBob = await bob.repos.members.getById(bobMember.id);
  expect(linkedBob).toMatchObject({ id: bobMember.id, name: 'Bob', userId: 'bob' });
  expect((await bob.repos.members.getByHousehold(hid)).filter((member) => member.name === 'Bob')).toHaveLength(1);
  expect(await bob.repos.memberships.getByUser('bob')).toEqual([
    expect.objectContaining({ householdId: hid, role: 'MEMBER' }),
  ]);
  expect(await mallory.repos.households.getAll()).toEqual([]);
  await expect(mallory.sync.pullChanges(hid)).rejects.toThrow();

  // Task ledger: exact zero-sum balance and the same member identity on both.
  await alice.repos.contributions.create({
    householdId: hid,
    label: 'Cuisine',
    performedByMemberId: ownerMember.id,
    beneficiaryMemberIds: [ownerMember.id, bobMember.id],
    value: 10,
    unit: 'points',
    persistentTaskId: null,
    occurredAt: new Date().toISOString(),
    createdBy: 'alice',
  });
  await pushAndPull(alice, bob, hid);
  const [aliceEntry] = await bob.repos.contributions.getByHousehold(hid);
  expect(aliceEntry).toMatchObject({ label: 'Cuisine', value: 10, unit: 'points' });
  const aBalances = calculateContributionBalances(await alice.repos.contributions.getByHousehold(hid), 'points');
  const bBalances = calculateContributionBalances(await bob.repos.contributions.getByHousehold(hid), 'points');
  expect(aBalances.get(ownerMember.id)).toBe(5);
  expect(aBalances.get(bobMember.id)).toBe(-5);
  expect(bBalances).toEqual(aBalances);

  // Money ledger: cent-exact shares and same money balances.
  await bob.repos.expenses.create({
    householdId: hid,
    title: 'Courses',
    amountMinor: 101,
    currency: 'CHF',
    paidByMemberId: bobMember.id,
    participantMemberIds: [ownerMember.id, bobMember.id],
    splitMode: 'equal',
    occurredAt: new Date().toISOString(),
    createdBy: 'bob',
  });
  await pushAndPull(bob, alice, hid);
  const [expense] = await alice.repos.expenses.getByHousehold(hid);
  expect(expense).toMatchObject({ title: 'Courses', amountMinor: 101, currency: 'CHF' });
  const aMoney = calculateFinancialBalances(await alice.repos.expenses.getByHousehold(hid), 'CHF');
  const bMoney = calculateFinancialBalances(await bob.repos.expenses.getByHousehold(hid), 'CHF');
  expect([...aMoney.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
  expect(bMoney).toEqual(aMoney);

  // Cross-ledger compensation is an explicit, rate-snapshotted operation.
  // The authority validates it against both authoritative ledgers and syncs it.
  const rate = {
    contributionValue: 1,
    contributionUnit: 'points' as const,
    moneyAmountMinor: 10,
    currency: 'CHF',
  };
  await alice.repos.households.update(hid, {
    crossLedgerCompensationEnabled: true,
    contributionToMoneyRate: rate,
  });
  await pushAndPull(alice, bob, hid);
  expect(await bob.repos.households.getById(hid)).toMatchObject({
    crossLedgerCompensationEnabled: true,
    contributionToMoneyRate: rate,
  });
  const settlement = await bob.repos.settlements.create({
    householdId: hid,
    contributionCreditorMemberId: ownerMember.id,
    counterpartyMemberId: bobMember.id,
    contributionValue: 5,
    contributionUnit: 'points',
    moneyAmountMinor: 50,
    currency: 'CHF',
    rateSnapshot: rate,
    occurredAt: new Date().toISOString(),
    createdBy: 'bob',
  });
  await pushAndPull(bob, alice, hid);
  expect(await alice.repos.settlements.getById(settlement.id)).toMatchObject({
    contributionValue: 5,
    moneyAmountMinor: 50,
    rateSnapshot: rate,
    createdBy: 'bob',
  });
  expect(await alice.repos.settlements.getByHousehold(hid)).toHaveLength(1);

  // A stale rate, an over-settlement and an edit/delete are all refused by the
  // authority without changing the ledger.
  const compensateMutation = (operationId: string, change: Record<string, unknown>) =>
    nodeFetch(`${baseUrl}/groups/${hid}/mutations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token('bob')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operationId, changes: [change] }),
    });
  const stale = await compensateMutation('stale-rate', {
    collection: 'settlements', id: 'settlement-stale', baseVersion: 0,
    value: {
      id: 'settlement-stale', householdId: hid,
      contributionCreditorMemberId: ownerMember.id, counterpartyMemberId: bobMember.id,
      contributionValue: 1, contributionUnit: 'points', moneyAmountMinor: 10, currency: 'CHF',
      rateSnapshot: { ...rate, moneyAmountMinor: 20 },
      occurredAt: new Date().toISOString(), createdBy: 'bob',
    },
  });
  expect(stale.status).toBe(400);
  const over = await compensateMutation('over-settlement', {
    collection: 'settlements', id: 'settlement-over', baseVersion: 0,
    value: {
      id: 'settlement-over', householdId: hid,
      contributionCreditorMemberId: ownerMember.id, counterpartyMemberId: bobMember.id,
      contributionValue: 5, contributionUnit: 'points', moneyAmountMinor: 50, currency: 'CHF',
      rateSnapshot: rate, occurredAt: new Date().toISOString(), createdBy: 'bob',
    },
  });
  expect(over.status).toBe(400);
  const deleted = await compensateMutation('delete-settlement', {
    collection: 'settlements', id: settlement.id, baseVersion: 1, value: null,
  });
  expect(deleted.status).toBe(400);
  expect(await alice.repos.settlements.getByHousehold(hid)).toHaveLength(1);

  // A member added after the group exists, then renamed, keeps one stable id.
  const chloe = await addGroupMember(alice.repos, hid, 'Chloé');
  await pushAndPull(alice, bob, hid);
  expect(await bob.repos.members.getById(chloe.id)).toMatchObject({ name: 'Chloé', userId: null });
  await renameGroupMember(alice.repos, hid, chloe.id, 'Chloé Renommée');
  await pushAndPull(alice, bob, hid);
  expect(await bob.repos.members.getById(chloe.id)).toMatchObject({ name: 'Chloé Renommée', userId: null });
  expect((await bob.repos.members.getByHousehold(hid)).filter((member) => member.id === chloe.id)).toHaveLength(1);

  // Group settings travel as an ordinary revisioned record.
  await alice.repos.households.update(hid, { name: 'Maison renommée' });
  await pushAndPull(alice, bob, hid);
  expect((await bob.repos.households.getById(hid))?.name).toBe('Maison renommée');

  // Client pull follows server pagination instead of stopping at 100 events.
  for (let index = 0; index < 105; index += 1) {
    const response = await nodeFetch(`${baseUrl}/groups/${hid}/mutations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token('alice')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: `bulk-category-${index}`,
        changes: [{
          collection: 'categories',
          id: `bulk-category-${index}`,
          baseVersion: 0,
          value: {
            id: `bulk-category-${index}`,
            householdId: hid,
            name: `Catégorie ${index}`,
            defaultTaskRatio: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }],
      }),
    });
    expect(response.status).toBe(200);
  }
  await bob.sync.pullChanges(hid);
  expect(await bob.repos.categories.getByHousehold(hid)).toHaveLength(105);

  // Offline edit is retained durably, then leaves through startSync after reconnect.
  bob.online = false;
  const offlineTodo = await bob.repos.todos.create({
    householdId: hid,
    title: 'Sortir les poubelles',
    kind: 'task',
    status: 'todo',
    assigneeMemberId: bobMember.id,
    beneficiaryMemberIds: [ownerMember.id, bobMember.id],
    dueAt: null,
    reminderAt: null,
    notes: '',
    persistentTaskId: null,
  });
  await expect(bob.sync.pushChanges(hid)).rejects.toThrow();
  expect(await bob.repos.syncState.getPendingMutation(hid)).not.toBeNull();
  bob.online = true;
  await bob.sync.startSync(hid);
  await alice.sync.pullChanges(hid);
  expect(await alice.repos.todos.getById(offlineTodo.id)).toMatchObject({ title: 'Sortir les poubelles' });

  // Concurrent edits: the loser is kept locally, the conflict is explicit, and
  // a later deliberate edit resolves it with the newest authority version.
  await alice.sync.pullChanges(hid);
  await bob.sync.pullChanges(hid);
  await alice.repos.contributions.update(aliceEntry.id, { label: 'Version Alice' });
  await alice.sync.pushChanges(hid);
  await bob.repos.contributions.update(aliceEntry.id, { label: 'Version Bob' });
  await expect(bob.sync.pushChanges(hid)).rejects.toThrow();
  expect((await bob.repos.contributions.getById(aliceEntry.id))?.label).toBe('Version Bob');
  expect((await bob.repos.syncState.getConflicts(hid)).some((conflict) => !conflict.resolvedAt)).toBe(true);
  await bob.sync.pullChanges(hid);
  // The background pull must not silently erase the local losing edit.
  expect((await bob.repos.contributions.getById(aliceEntry.id))?.label).toBe('Version Bob');
  const kept = (await bob.sync.getConflicts!(hid))[0];
  await bob.sync.resolveConflict!(hid, kept.id, 'local');
  await alice.sync.pullChanges(hid);
  expect((await alice.repos.contributions.getById(aliceEntry.id))?.label).toBe('Version Bob');
  expect((await bob.repos.syncState.getConflicts(hid)).filter((conflict) => !conflict.resolvedAt)).toHaveLength(0);

  // The same UI can deliberately take the authority payload instead.
  await alice.repos.contributions.update(aliceEntry.id, { label: 'Version Alice 2' });
  await alice.sync.pushChanges(hid);
  await bob.repos.contributions.update(aliceEntry.id, { label: 'Version Bob 2' });
  await expect(bob.sync.pushChanges(hid)).rejects.toThrow();
  const remoteChoice = (await bob.sync.getConflicts!(hid))[0];
  await bob.sync.resolveConflict!(hid, remoteChoice.id, 'remote');
  expect((await bob.repos.contributions.getById(aliceEntry.id))?.label).toBe('Version Alice 2');
  await alice.sync.pullChanges(hid);
  expect((await alice.repos.contributions.getById(aliceEntry.id))?.label).toBe('Version Alice 2');
  expect((await bob.repos.syncState.getConflicts(hid)).filter((conflict) => !conflict.resolvedAt)).toHaveLength(0);

  // Deletion is a real tombstone, not a local disappearance.
  await bob.repos.contributions.delete(aliceEntry.id);
  await bob.sync.pushChanges(hid);
  await alice.sync.pullChanges(hid);
  expect(await alice.repos.contributions.getById(aliceEntry.id)).toBeNull();
  expect(await bob.repos.contributions.getById(aliceEntry.id)).toBeNull();

  // Restarting the authority keeps events; restarting clients keeps their
  // cursors and does not duplicate or re-upload data.
  const aliceBefore = await alice.repos.contributions.getByHousehold(hid);
  const bobBefore = await bob.repos.expenses.getByHousehold(hid);
  const cursorBefore = (await bob.repos.syncState.getGroupState(hid))?.lastRevision;
  await stopServer();
  store = new CollaborationStore(join(directory, 'authority.sqlite'));
  const verifier = new FirebaseTokenVerifier('chorescore-test', async () => ({ 'test-key': publicKey }));
  server = createCollaborationServer(store, verifier);
  await listen();

  const aliceRestarted = client('alice', alice.repos);
  const bobRestarted = client('bob', bob.repos);
  await bobRestarted.sync.startSync(hid);
  await aliceRestarted.sync.startSync(hid);
  expect(await alice.repos.contributions.getByHousehold(hid)).toEqual(aliceBefore);
  expect(await bob.repos.expenses.getByHousehold(hid)).toEqual(bobBefore);
  expect((await bob.repos.syncState.getGroupState(hid))?.lastRevision).toBe(cursorBefore);

  // A member cannot mutate another group through a forged group id: the token
  // identity is never replaced by a device-local id.
  const forged = await nodeFetch(`${baseUrl}/groups/${hid}/mutations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token('mallory')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'forged',
      changes: [{
        collection: 'categories',
        id: 'forged-category',
        baseVersion: 0,
        value: {
          id: 'forged-category',
          householdId: hid,
          name: 'Intrusion',
          defaultTaskRatio: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }],
    }),
  });
  expect(forged.status).toBe(403);
});
