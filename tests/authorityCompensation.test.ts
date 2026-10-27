import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationStore } from '../backend/store';
import { FirebaseSyncTransport } from '../src/infrastructure/firebase/FirebaseSyncTransport';
import { InMemoryFirestore } from './helpers/InMemoryFirestore';

type Change = { collection: string; id: string; baseVersion: number; value: any };
async function authority(mode: 'http' | 'firebase') {
  const folder = mkdtempSync(join(tmpdir(), 'chorescore-authority-audit-'));
  const store = mode === 'http' ? new CollaborationStore(join(folder, 'server.db')) : null;
  const transport = mode === 'firebase' ? new FirebaseSyncTransport({
    client: new InMemoryFirestore(), getAccessToken: async () => 'test-token', getUid: () => 'alice',
  }) : null;
  const groupId = `audit-${mode}`;
  const input = { id: groupId, name: 'Audit', unit: 'points', ownerMemberId: 'alice-member', ownerName: 'Alice',
    membershipId: 'alice-membership', members: [{ id: 'bob-member', name: 'Bob' }] };
  if (store) store.createGroup('alice', input);
  else await transport!.request('POST', '/groups', input);
  let sequence = 0;
  const mutate = async (changes: Change[]) => {
    const operationId = `operation-${++sequence}`;
    return store ? store.mutate('alice', groupId, operationId, changes)
      : transport!.request('POST', `/groups/${groupId}/mutations`, { operationId, changes });
  };
  const events = async () => store ? store.deltas('alice', groupId, 0)
    : await transport!.request('GET', `/groups/${groupId}/deltas?since=0`) as any;
  const initial: any = await events();
  const household = initial.events[0].changes.find((change: Change) => change.collection === 'households').value;
  const rate = { contributionValue: 1, contributionUnit: 'points', moneyAmountMinor: 100, currency: 'CHF' };
  const now = new Date().toISOString();
  const ids = ['alice-member', 'bob-member'];
  await mutate([
    { collection: 'households', id: groupId, baseVersion: 1,
      value: { ...household, crossLedgerCompensationEnabled: true, contributionToMoneyRate: rate } },
    { collection: 'contribution_entries', id: 'task', baseVersion: 0,
      value: { id: 'task', householdId: groupId, label: 'Task', value: 10, unit: 'points', performedByMemberId: ids[0],
        beneficiaryMemberIds: ids, occurredAt: now, createdBy: 'alice', persistentTaskId: null } },
    { collection: 'expense_entries', id: 'expense', baseVersion: 0,
      value: { id: 'expense', householdId: groupId, title: 'Expense', amountMinor: 1000, currency: 'CHF',
        paidByMemberId: ids[1], participantMemberIds: ids, splitMode: 'equal', occurredAt: now, createdBy: 'alice' } },
  ]);
  const settlement = (id: string, value: number): Change => ({ collection: 'settlements', id, baseVersion: 0,
    value: { id, householdId: groupId, contributionCreditorMemberId: ids[0], counterpartyMemberId: ids[1],
      contributionValue: value, contributionUnit: 'points', moneyAmountMinor: value * 100, currency: 'CHF',
      rateSnapshot: rate, occurredAt: now, createdBy: 'forged-user' } });
  return { mutate, events, settlement, close: () => { store?.close(); rmSync(folder, { recursive: true, force: true }); } };
}

describe.each(['http', 'firebase'] as const)('%s compensation authority', mode => {
  test('two individually affordable settlements cannot overdraw credit in one batch', async () => {
    const service = await authority(mode);
    try {
      await expect(service.mutate([service.settlement('settlement-one', 3), service.settlement('settlement-two', 3)])).rejects.toThrow();
      const result: any = await service.events();
      expect(result.events.flatMap((event: any) => event.changes).filter((change: Change) => change.collection === 'settlements')).toEqual([]);
      await service.mutate([service.settlement('settlement-valid', 2)]);
      const after: any = await service.events();
      expect(after.events.flatMap((event: any) => event.changes).find((change: Change) => change.collection === 'settlements').value.createdBy).toBe('alice');
    } finally { service.close(); }
  });

  test('staged references never authorize a cross-group payload or a completion without its ledger', async () => {
    const service = await authority(mode);
    try {
      const before: any = await service.events();
      const task = before.events.flatMap((event: any) => event.changes).find((change: Change) => change.collection === 'contribution_entries').value;
      await expect(service.mutate([
        { collection: 'contribution_entries', id: 'dependent', baseVersion: 0,
          value: { ...task, id: 'dependent', categoryId: 'forged-category' } },
        { collection: 'categories', id: 'forged-category', baseVersion: 0,
          value: { id: 'forged-category', householdId: 'another-group', name: 'Forged', defaultTaskRatio: null } },
      ])).rejects.toThrow();
      await expect(service.mutate([{ collection: 'todo_items', id: 'forged-todo', baseVersion: 0, value: {
        id: 'forged-todo', householdId: task.householdId, title: 'Fake completion', status: 'completed', kind: 'task',
        assigneeMemberId: 'alice-member', beneficiaryMemberIds: ['alice-member', 'bob-member'], completedAt: new Date().toISOString(),
      } }])).rejects.toThrow('atomic completion');
      expect(await service.events()).toEqual(before);
    } finally { service.close(); }
  });

  test('deleted ledger tombstones do not prevent a later valid compensation', async () => {
    const service = await authority(mode);
    try {
      const initial: any = await service.events();
      const expense = initial.events.flatMap((event: any) => event.changes).find((change: Change) => change.collection === 'expense_entries').value;
      await service.mutate([{ collection: 'expense_entries', id: 'temporary', baseVersion: 0, value: { ...expense, id: 'temporary' } }]);
      await service.mutate([{ collection: 'expense_entries', id: 'temporary', baseVersion: 1, value: null }]);
      await service.mutate([service.settlement('after-deletion', 1)]);
      const after: any = await service.events();
      expect(after.events.flatMap((event: any) => event.changes).filter((change: Change) => change.collection === 'settlements')).toHaveLength(1);
    } finally { service.close(); }
  });
});
