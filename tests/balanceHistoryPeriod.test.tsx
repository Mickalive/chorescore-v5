import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import BalancesScreen from '../app/(tabs)/balances';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

const mockApp = jest.fn();
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
const mockTranslate = (key: string) => key === 'unit.pointsShort' ? 'pts' : key;
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: mockTranslate, locale: 'fr' }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => children }));

test('history periods hide old entries without hiding their perpetual task or money debt', async () => {
  const repos = createInMemoryRepositories();
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'a', displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  const ids = [ownerMember.id, namedMembers[0].id];
  const now = new Date().toISOString();
  for (const [label, value, occurredAt] of [['Ancienne tâche', 6, '2000-01-01T12:00:00.000Z'], ['Récente tâche', 4, now]] as const) {
    await repos.contributions.create({ householdId: household.id, label, value, occurredAt,
      performedByMemberId: ids[0], beneficiaryMemberIds: ids, unit: 'points', persistentTaskId: null, createdBy: 'a' });
  }
  await repos.expenses.create({ householdId: household.id, title: 'Ancienne dépense', amountMinor: 101, currency: 'CHF',
    paidByMemberId: ids[0], participantMemberIds: ids, splitMode: 'custom',
    customShares: [{ memberId: ids[0], amountMinor: 50 }, { memberId: ids[1], amountMinor: 51 }],
    occurredAt: '2000-01-01T12:00:00.000Z', createdBy: 'a' });
  await repos.expenses.create({ householdId: household.id, title: 'Récente dépense', amountMinor: 200, currency: 'CHF',
    paidByMemberId: ids[0], participantMemberIds: ids, splitMode: 'equal', occurredAt: now, createdBy: 'a' });
  const fullReads=[jest.spyOn(repos.contributions,'getByHousehold'),jest.spyOn(repos.expenses,'getByHousehold'),jest.spyOn(repos.settlements,'getByHousehold')];
  for (const read of fullReads) read.mockRejectedValue(new Error('Screen must read the projection, not complete ledgers'));
  let notify!: (type: string, householdId: string) => Promise<void>;
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'a' }, repos,
    subscribeToDataChanges: (listener: typeof notify) => { notify = listener; return () => undefined; },
    emitDataChange: jest.fn(), services: {} });
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<BalancesScreen />); });
    const content = () => JSON.stringify(tree.toJSON());
    const labels: Record<string, string> = { week: 'balances.periodWeek', 'all-time': 'balances.periodAll' };
    const select = (period: string) => tree.root.findAllByType(TouchableOpacity)
      .find(button => button.findAllByType(Text).some(text => text.props.children === labels[period]))!.props.onPress();
    expect(content()).toContain('Ancienne tâche');
    expect(content()).toContain('+ 5 pts');
    expect(content()).toMatch(/\+ 1,51\sCHF/);
    await act(async () => { select('week'); });
    expect(content()).not.toContain('Ancienne tâche');
    expect(content()).not.toContain('Ancienne dépense');
    expect(content()).toContain('Récente tâche');
    expect(content()).toContain('Récente dépense');
    expect(content()).toContain('+ 5 pts');
    expect(content()).toMatch(/\+ 1,51\sCHF/);
    await act(async () => { select('all-time'); });
    expect(content()).toContain('Ancienne tâche');
    expect(content()).toContain('Ancienne dépense');
    for (const read of fullReads) { expect(read).not.toHaveBeenCalled(); read.mockRestore(); }
    expect(await repos.contributions.getByHousehold(household.id)).toHaveLength(2);
    expect(await repos.expenses.getByHousehold(household.id)).toHaveLength(2);
    await repos.members.create({ householdId: household.id, name: 'Charlie', userId: null });
    await act(async () => { await notify('member', household.id); });
    expect(content()).toContain('Charlie');
    expect(content()).toContain('0 pts');
    expect(content()).toContain('+ 5 pts');
    expect(content()).toMatch(/\+ 1,51\sCHF/);
    expect(content()).toMatch(/0,00\sCHF/);
  } finally {
    for (const read of fullReads) read.mockRestore();
    await act(async () => tree.unmount());
  }
});

test('a history read failure shows retry without claiming the group is empty and recovers persisted rows', async () => {
  const repos = createInMemoryRepositories();
  const { household, ownerMember } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'a', displayName: 'Alice' }, memberNames: [], contributionUnit: 'points',
  });
  await repos.contributions.create({ householdId: household.id, label: 'Écriture conservée', value: 6,
    occurredAt: new Date().toISOString(), performedByMemberId: ownerMember.id,
    beneficiaryMemberIds: [ownerMember.id], unit: 'points', persistentTaskId: null, createdBy: 'a' });
  const read = jest.spyOn(repos.contributions, 'getByHouseholdPaginated').mockRejectedValue(new Error('SQLite busy'));
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'a' }, repos,
    subscribeToDataChanges: () => () => {}, emitDataChange: jest.fn(), services: {} });
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<BalancesScreen />); });
  expect(JSON.stringify(tree.toJSON())).toContain('balances.historyError');
  expect(JSON.stringify(tree.toJSON())).not.toContain('balances.emptyActivity');
  read.mockRestore();
  const { Button } = require('../src/ui/components/Button');
  const retry = tree.root.findAllByType(Button).find(button => button.props.title === 'action.retry')!;
  await act(async () => retry.props.onPress());
  expect(JSON.stringify(tree.toJSON())).toContain('Écriture conservée');
  expect(JSON.stringify(tree.toJSON())).not.toContain('balances.historyError');
  read.mockRestore();
  await act(async () => tree.unmount());
});
