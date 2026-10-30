import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { TextInput, TouchableOpacity } from 'react-native';
import GroupOptionsScreen from '../app/group-options';
import BalancesScreen from '../app/(tabs)/balances';
import { Button } from '../src/ui/components/Button';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

const mockApp = jest.fn();
jest.mock('expo-notifications', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'fr' }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => children }));

test('custom French compensation settles the exact amount once on double confirmation', async () => {
  const repos = createInMemoryRepositories();
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'a', displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  const ids = [ownerMember.id, namedMembers[0].id];
  const rate = { contributionValue: 1.5, contributionUnit: 'points' as const, moneyAmountMinor: 150, currency: 'CHF' };
  await repos.households.update(household.id, { crossLedgerCompensationEnabled: true, contributionToMoneyRate: rate });
  await repos.contributions.create({ householdId: household.id, label: 'Cuisine', value: 6,
    occurredAt: new Date().toISOString(), performedByMemberId: ids[0], beneficiaryMemberIds: ids,
    unit: 'points', persistentTaskId: null, createdBy: 'a' });
  await repos.expenses.create({ householdId: household.id, title: 'Courses', amountMinor: 600, currency: 'CHF',
    paidByMemberId: ids[1], participantMemberIds: ids, splitMode: 'equal',
    occurredAt: new Date().toISOString(), createdBy: 'a' });
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'a' }, repos,
    subscribeToDataChanges: () => () => undefined, emitDataChange: jest.fn(), services: {} });
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<BalancesScreen />); });
    const button = (id: string) => tree.root.findAllByType(Button).find(node => node.props.testID === id)!;
    act(() => button('balances.compensateButton').props.onPress());
    act(() => tree.root.findAllByType(TouchableOpacity).find(node => node.props.testID === `balances.compenserCreditor.${ids[0]}`)!.props.onPress());
    const field = tree.root.findAllByType(TextInput).find(node => node.props.testID === 'balances.compenserValue')!;
    expect(field).toBeDefined();
    act(() => field.props.onChangeText('1,5'));
    expect(button('balances.compenserConfirm').props.disabled).toBe(false);
    const create = jest.spyOn(repos.settlements, 'create').mockRejectedValueOnce(new Error('disk unavailable'));
    await act(async () => { await button('balances.compenserConfirm').props.onPress(); });
    expect(await repos.settlements.getByHousehold(household.id)).toHaveLength(0);
    expect(button('balances.compenserConfirm').props.loading).toBe(false);
    expect(field.props.value).toBe('1,5');
    const confirm = button('balances.compenserConfirm').props.onPress;
    await act(async () => { await Promise.all([confirm(), confirm()]); });
    expect(create).toHaveBeenCalledTimes(2); // one failure, one persisted retry

    expect(await repos.settlements.getByHousehold(household.id)).toEqual([
      expect.objectContaining({ contributionValue: 1.5, moneyAmountMinor: 150, rateSnapshot: rate }),
    ]);
    // Reopening the screen must use the persisted settlement exactly once.
    await act(async () => tree.unmount());
    await act(async () => { tree = renderer.create(<BalancesScreen />); });
    expect(JSON.stringify(tree.toJSON())).toContain('+ 1,5');
    expect(await repos.settlements.getByHousehold(household.id)).toHaveLength(1);
  } finally { if (tree) await act(async () => tree.unmount()); }
});


test('group rate saves decimal commas and refuses fractions smaller than a cent', async () => {
  const repos = createInMemoryRepositories();
  const { household } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'a', displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'a' }, repos,
    services: { sync: { isAvailable: () => false } }, subscribeToDataChanges: () => () => undefined,
    emitDataChange: jest.fn() });
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<GroupOptionsScreen />); });
    act(() => tree.root.findAllByType(TouchableOpacity).find(node => node.props.testID === 'groupOptions.compensationToggle')!.props.onPress());
    const field = (id: string) => tree.root.findAllByType(TextInput).find(node => node.props.testID === id)!;
    act(() => field('groupOptions.rateContribution').props.onChangeText('1,5'));
    act(() => field('groupOptions.rateMoney').props.onChangeText('1,01'));
    const save = () => tree.root.findAllByType(Button).find(node => node.props.testID === 'groupOptions.save')!.props.onPress();
    await act(async () => { await save(); });
    expect((await repos.households.getById(household.id))!.contributionToMoneyRate).toEqual({
      contributionValue: 1.5, contributionUnit: 'points', moneyAmountMinor: 101, currency: 'CHF',
    });
    act(() => field('groupOptions.rateMoney').props.onChangeText('1.005'));
    await act(async () => { await save(); });
    expect((await repos.households.getById(household.id))!.contributionToMoneyRate!.moneyAmountMinor).toBe(101);
  } finally { if (tree) await act(async () => tree.unmount()); }
});
