import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import { TaskShortcutsManager } from '../src/features/shortcuts/TaskShortcutsManager';
import { Button } from '../src/ui/components/Button';
import { saveTaskShortcut } from '../src/application/use-cases/taskShortcuts';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';
const mockApp = jest.fn();
const mockTranslate = (key: string) => key;
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: mockTranslate }) }));
async function fixture() {
  const repos = createInMemoryRepositories();
  const { household, ownerMember } = await createGroupWithMembers(repos, { name: 'Maison', owner: { userId: 'alice', displayName: 'Alice' }, memberNames: [], contributionUnit: 'points' });
  return { repos, household, ownerMember, draft: { householdId: household.id, name: ' Cuisine ', value: '3,5', unit: 'points' as const, beneficiaryMemberIds: [ownerMember.id] } };
}
test('saving validates current group members and unit, creates no realization, and rejects invalid values', async () => {
  const { repos, household, draft } = await fixture();
  const shortcut = await saveTaskShortcut(repos, draft);
  expect(shortcut).toMatchObject({ name: 'Cuisine', defaultValue: 3.5, defaultUnit: 'points', defaultBeneficiaryMemberIds: draft.beneficiaryMemberIds });
  expect(await repos.contributions.getByHousehold(household.id)).toEqual([]);
  for (const value of ['0', '-1', 'NaN', 'Infinity']) await expect(saveTaskShortcut(repos, { ...draft, value })).rejects.toThrow();
  await expect(saveTaskShortcut(repos, { ...draft, beneficiaryMemberIds: ['foreign'] })).rejects.toThrow();
  await repos.households.update(household.id, { contributionUnit: 'minutes' });
  await expect(saveTaskShortcut(repos, draft)).rejects.toThrow();
  expect(await repos.tasks.getByHousehold(household.id)).toHaveLength(1);
});

test('two save taps create one shortcut; confirmed removal preserves existing ledger references', async () => {
  const { repos, household, ownerMember, draft } = await fixture();
  mockApp.mockReturnValue({ repos, emitDataChange: jest.fn() });
  const onSaved = jest.fn(), onDeleted = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  const props = { ...draft, tasks: [], onSaved, onDeleted };
  await act(async () => { tree = renderer.create(<TaskShortcutsManager {...props} />); });
  const button = (id: string) => tree.root.findAllByType(Button).find(node => node.props.testID === id)!;
  await act(async () => button('shortcuts.manage').props.onPress());
  const save = button('shortcuts.save').props.onPress;
  await act(async () => { await Promise.all([save(), save()]); });
  expect(onSaved).toHaveBeenCalledTimes(1);
  const [shortcut] = await repos.tasks.getByHousehold(household.id);
  const entry = await repos.contributions.create({ householdId: household.id, label: 'Cuisine réelle', value: 3.5, unit: 'points',
    performedByMemberId: ownerMember.id, beneficiaryMemberIds: [ownerMember.id], persistentTaskId: shortcut.id, occurredAt: new Date().toISOString(), createdBy: 'alice' });
  await act(async () => tree.update(<TaskShortcutsManager {...props} tasks={[shortcut]} />));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await act(async () => button(`shortcuts.delete.${shortcut.id}`).props.onPress());
  const confirm = (alert.mock.calls[0][2] as any[]).find(action => action.style === 'destructive');
  await act(async () => { confirm.onPress(); });
  expect(await repos.tasks.getByHousehold(household.id)).toEqual([]);
  expect(await repos.contributions.getById(entry.id)).toEqual(entry);
  expect(onDeleted).toHaveBeenCalledWith(shortcut.id);
  alert.mockRestore();
  await act(async () => tree.unmount());
});
