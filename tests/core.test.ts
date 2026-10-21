import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';
import { completeTodoAtomic } from '../src/application/use-cases/completeTodoAtomic';
import { calculateContributionBalances } from '../src/domain/calculations/contributionLedger';
import { calculateFinancialBalancesByCurrency } from '../src/domain/calculations/expenseLedger';

async function fixture(kind: 'task' | 'expense' = 'task') {
  const repos = createInMemoryRepositories();
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'account-a', displayName: 'Alice' },
    memberNames: ['Bob'], contributionUnit: 'points',
  });
  const ids = [ownerMember.id, namedMembers[0].id];
  const todo = await repos.todos.create({ householdId: household.id, title: 'Courses', kind,
    assigneeMemberId: ids[0], beneficiaryMemberIds: ids, dueAt: null, reminderAt: null,
    notes: 'Ne pas oublier', persistentTaskId: null, status: 'todo' });
  const common = { todo, household, completedByUserId: 'account-a' };
  const input = kind === 'task'
    ? { ...common, performerMemberId: ids[0], value: 9, beneficiaryMemberIds: ids }
    : { ...common, paidByMemberId: ids[0], amountMinor: 101, currency: 'EUR', participantMemberIds: ids };
  return { repos, household, ids, todo, input };
}

test('group creation keeps the selected unit and distinct named identities', async () => {
  const { repos, household, ids } = await fixture();
  expect((await repos.households.getById(household.id))?.contributionUnit).toBe('points');
  expect(ids[0]).not.toBe(ids[1]);
  expect((await repos.members.getById(ids[1]))?.userId).toBeNull();
  expect(await repos.categories.getByHousehold(household.id)).toEqual([]);
});

for (const kind of ['task', 'expense'] as const) {
  test(`${kind}: simultaneous completion from the same stale screen creates exactly one entry`, async () => {
    const { repos, household, todo, input } = await fixture(kind);
    const outcomes = await Promise.allSettled([
      completeTodoAtomic(repos, input), completeTodoAtomic(repos, input),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
    const entries = kind === 'task'
      ? await repos.contributions.getByHousehold(household.id)
      : await repos.expenses.getByHousehold(household.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].note).toBe('Ne pas oublier');
    expect((await repos.todos.getById(todo.id))?.status).toBe('completed');
    await expect(completeTodoAtomic(repos, input)).rejects.toThrow('already completed');
  });

  test(`${kind}: failed todo write rolls back ledger and outbox; retry succeeds`, async () => {
    const { repos, household, todo, input } = await fixture(kind);
    const original = repos.todos.update.bind(repos.todos);
    const failure = jest.spyOn(repos.todos, 'update').mockRejectedValueOnce(new Error('disk full'));
    await expect(completeTodoAtomic(repos, input)).rejects.toThrow('disk full');
    expect((await repos.todos.getById(todo.id))?.status).toBe('todo');
    expect(await repos.contributions.getByHousehold(household.id)).toHaveLength(0);
    expect(await repos.expenses.getByHousehold(household.id)).toHaveLength(0);
    const collection = kind === 'task' ? 'contribution_entries' : 'expense_entries';
    expect(await repos.syncState.getDirtyRecords(household.id, collection, 0)).toHaveLength(0);
    failure.mockImplementation(original);
    await completeTodoAtomic(repos, input);
    expect((await repos.todos.getById(todo.id))?.status).toBe('completed');
  });
}

test('completion preserves zero sum, selected task unit and exact expense cents', async () => {
  const { repos, household, ids, input } = await fixture();
  await completeTodoAtomic(repos, input);
  const tasks = await repos.contributions.getByHousehold(household.id);
  const balances = calculateContributionBalances(tasks, 'points');
  expect([...balances.values()].reduce((a, b) => a + b, 0)).toBe(0);
  expect(calculateContributionBalances(tasks, 'minutes').size).toBe(0);
  await repos.expenses.create({ householdId: household.id, title: 'Pain', amountMinor: 101,
    currency: 'EUR', paidByMemberId: ids[0], participantMemberIds: ids, splitMode: 'equal',
    occurredAt: new Date().toISOString(), createdBy: 'account-a' });
  const money = calculateFinancialBalancesByCurrency(await repos.expenses.getByHousehold(household.id));
  expect([...money.get('EUR')!.values()].reduce((a, b) => a + b, 0)).toBe(0);
  expect(money.get('EUR')!.get(ids[0])).toBe(50);
});

test('todo completion snapshots a category ratio; later changes cannot reinterpret history', async () => {
  const { repos, household, ids, input } = await fixture();
  if (!('value' in input)) throw new Error('Expected task input');
  const category = await repos.categories.create({ householdId: household.id, name: 'Entretien libre',
    defaultTaskRatio: [{ memberId:ids[0],weight:2 },{ memberId:ids[1],weight:1 }] });
  await completeTodoAtomic(repos, { ...input, category, categoryId:category.id, categoryLabelSnapshot:category.name });
  await repos.categories.update(category.id,{ defaultTaskRatio:[{memberId:ids[0],weight:1},{memberId:ids[1],weight:4}] });
  const entries = await repos.contributions.getByHousehold(household.id);
  expect(entries[0]).toMatchObject({ categoryId:category.id, splitSource:'category-default',
    splitWeights:[{memberId:ids[0],weight:2},{memberId:ids[1],weight:1}] });
  expect(calculateContributionBalances(entries,'points').get(ids[0])).toBe(3);
});
test('an explicit blank note on completion clears the prefilled todo note', async () => {
  const { repos, household, input } = await fixture();
  await completeTodoAtomic(repos,{ ...input, note:'' });
  expect((await repos.contributions.getByHousehold(household.id))[0].note).toBeUndefined();
});
test('expense todo custom shares preserve every cent; invalid shares commit nothing', async () => {
  const { repos, household, ids, input } = await fixture('expense');
  if (!('amountMinor' in input)) throw new Error('Expected expense input');
  await expect(completeTodoAtomic(repos,{ ...input,
    customShares:[{memberId:ids[0],amountMinor:34},{memberId:ids[1],amountMinor:66}],
  })).rejects.toThrow();
  expect(await repos.expenses.getByHousehold(household.id)).toHaveLength(0);
  await completeTodoAtomic(repos,{ ...input,
    customShares:[{memberId:ids[0],amountMinor:34},{memberId:ids[1],amountMinor:67}],
  });
  const entries = await repos.expenses.getByHousehold(household.id);
  expect(entries[0].customShares?.map(share => share.amountMinor)).toEqual([34,67]);
  expect(calculateFinancialBalancesByCurrency(entries).get('EUR')?.get(ids[0])).toBe(67);
});
