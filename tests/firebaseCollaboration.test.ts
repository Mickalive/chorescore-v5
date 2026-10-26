/**
 * Real RemoteSyncAdapter + FirebaseSpark transport, exercised against an
 * in-memory FirestorePort. This proves the Firestore authority's atomic
 * mutations, invitations, tenant isolation, deltas and idempotent retries
 * without claiming a deployed Firebase project or security-rule execution.
 */
import {
  createInMemoryRepositories,
  AllRepositories,
} from '../src/infrastructure/repositories/RepositoryFactory';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';
import { FirebaseSyncTransport } from '../src/infrastructure/firebase/FirebaseSyncTransport';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';
import { calculateContributionBalances } from '../src/domain/calculations/contributionLedger';
import { calculateFinancialBalances } from '../src/domain/calculations/expenseLedger';
import { InMemoryFirestore } from './helpers/InMemoryFirestore';

const firestore = new InMemoryFirestore();
let clock = Date.parse('2026-10-26T10:00:00.000Z');
let tokenSequence = 0;

interface Client {
  uid: string;
  repos: AllRepositories;
  sync: RemoteSyncAdapter;
}

function client(uid: string): Client {
  const repos = createInMemoryRepositories();
  const transport = new FirebaseSyncTransport({
    client: firestore,
    getAccessToken: async () => `token-${uid}`,
    getUid: () => uid,
    now: () => clock,
    createToken: async () => {
      tokenSequence += 1;
      return `${String(tokenSequence).padStart(2, '0')}${'a'.repeat(41)}`;
    },
    createId: () => `membership-${uid}-${tokenSequence}`,
  });
  const sync = new RemoteSyncAdapter({
    request: (method, path, body) => transport.request(method, path, body),
    getAccessToken: async () => `token-${uid}`,
    getRepos: () => repos,
    pollIntervalMs: 0,
  });
  return { uid, repos, sync };
}

async function pushAndPull(source: Client, target: Client, householdId: string): Promise<void> {
  await source.sync.pushChanges(householdId);
  await target.sync.pullChanges(householdId);
}

test('Firebase authority shares exact ledgers, links invited members and isolates tenants', async () => {
  const alice = client('alice');
  const bob = client('bob');
  const mallory = client('mallory');

  const { household, ownerMember, namedMembers } = await createGroupWithMembers(alice.repos, {
    name: 'Maison Firebase',
    owner: { userId: 'alice', displayName: 'Alice' },
    memberNames: ['Bob'],
    contributionUnit: 'points',
  });
  const bobMember = namedMembers[0];
  const hid = household.id;

  await alice.sync.ensureRemoteGroup(hid, 'alice');
  const storedGroup = firestore.read(`groups/${hid}`);
  expect(storedGroup?.fields).toMatchObject({
    ownerId: 'alice',
    revision: 1,
    memberUids: ['alice'],
  });
  expect(storedGroup?.fields.access).toEqual({
    alice: { memberId: ownerMember.id, role: 'OWNER' },
  });

  const invitation = await alice.sync.createInvitation(hid, bobMember.id);
  expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await bob.sync.acceptInvitation(invitation.token);

  const bobHousehold = await bob.repos.households.getById(hid);
  expect(bobHousehold).toMatchObject({ id: hid, name: 'Maison Firebase', contributionUnit: 'points' });
  expect(await bob.repos.members.getById(bobMember.id)).toMatchObject({
    id: bobMember.id,
    name: 'Bob',
    userId: 'bob',
  });
  expect(await bob.repos.memberships.getByUser('bob')).toEqual([
    expect.objectContaining({ householdId: hid, role: 'MEMBER' }),
  ]);
  expect(firestore.read(`groups/${hid}`)?.fields.memberUids).toEqual(['alice', 'bob']);

  expect(await mallory.repos.households.getAll()).toEqual([]);
  await expect(mallory.sync.pullChanges(hid)).rejects.toMatchObject({ status: 403 });
  expect(firestore.read(`groups/${hid}`)?.fields.access).not.toHaveProperty('mallory');

  await alice.repos.contributions.create({
    householdId: hid,
    label: 'Cuisine',
    performedByMemberId: ownerMember.id,
    beneficiaryMemberIds: [ownerMember.id, bobMember.id],
    value: 10,
    unit: 'points',
    persistentTaskId: null,
    occurredAt: new Date(clock).toISOString(),
    createdBy: 'alice',
  });
  await pushAndPull(alice, bob, hid);
  const bobContributions = await bob.repos.contributions.getByHousehold(hid);
  expect(bobContributions).toEqual([
    expect.objectContaining({ label: 'Cuisine', value: 10, unit: 'points' }),
  ]);
  const aliceBalances = calculateContributionBalances(
    await alice.repos.contributions.getByHousehold(hid),
    'points',
  );
  const bobBalances = calculateContributionBalances(bobContributions, 'points');
  expect(aliceBalances.get(ownerMember.id)).toBe(5);
  expect(aliceBalances.get(bobMember.id)).toBe(-5);
  expect(bobBalances).toEqual(aliceBalances);

  await bob.repos.expenses.create({
    householdId: hid,
    title: 'Courses',
    amountMinor: 101,
    currency: 'CHF',
    paidByMemberId: bobMember.id,
    participantMemberIds: [ownerMember.id, bobMember.id],
    splitMode: 'equal',
    occurredAt: new Date(clock).toISOString(),
    createdBy: 'bob',
  });
  await pushAndPull(bob, alice, hid);
  expect(await alice.repos.expenses.getByHousehold(hid)).toEqual([
    expect.objectContaining({ title: 'Courses', amountMinor: 101, currency: 'CHF' }),
  ]);
  const money = calculateFinancialBalances(
    await alice.repos.expenses.getByHousehold(hid),
    'CHF',
  );
  expect([...money.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
  expect(money.get(ownerMember.id)).toBe(-51);
  expect(money.get(bobMember.id)).toBe(51);

  const revisionBeforeReplay = Number(firestore.read(`groups/${hid}`)?.fields.revision);
  const categoryChange = {
    operationId: 'op-category-once',
    changes: [
      {
        collection: 'categories',
        id: 'category-clean',
        baseVersion: 0,
        value: {
          id: 'category-clean',
          householdId: hid,
          name: 'Ménage',
          defaultTaskRatio: null,
          createdAt: new Date(clock).toISOString(),
          updatedAt: new Date(clock).toISOString(),
        },
      },
    ],
  };
  const first = await alice.sync['request']('POST', `/groups/${encodeURIComponent(hid)}/mutations`, categoryChange);
  const replay = await alice.sync['request']('POST', `/groups/${encodeURIComponent(hid)}/mutations`, categoryChange);
  expect(replay).toEqual(first);
  expect(Number(firestore.read(`groups/${hid}`)?.fields.revision)).toBe(revisionBeforeReplay + 1);

  await expect(
    alice.sync['request']('POST', `/groups/${encodeURIComponent(hid)}/mutations`, {
      ...categoryChange,
      changes: [{ ...categoryChange.changes[0], value: { ...categoryChange.changes[0].value, name: 'Different' } }],
    }),
  ).rejects.toMatchObject({ status: 409 });

  const secondInvitation = await alice.sync.createInvitation(hid, ownerMember.id).catch((error) => error);
  expect(secondInvitation).toMatchObject({ status: 400 });

  const malloryInvite = await bob.sync.createInvitation(hid, ownerMember.id).catch((error) => error);
  expect(malloryInvite).toMatchObject({ status: 403 });

  await alice.sync.revokeInvitation(hid, invitation.token);
  const carol = client('carol');
  await expect(carol.sync.acceptInvitation(invitation.token)).rejects.toMatchObject({ status: 404 });
  expect(firestore.read(`groups/${hid}`)?.fields.access).not.toHaveProperty('carol');
});
