import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput } from 'react-native';
import TodosScreen from '../app/(tabs)/todos';
import { Button } from '../src/ui/components/Button';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

const mockApp = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
let mockLocale = 'fr';
const mockTranslate = (key: string, values?: Record<string, unknown>) => key === 'todos.dueLabel' ? String(values?.date) : key;
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: mockTranslate, locale: mockLocale }) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => children }));

test('todo notes persist in a single scrolling form that dismisses the keyboard', async () => {
  const previousOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  const repos = createInMemoryRepositories();
  const { household } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'a', displayName: 'Alice' },
    memberNames: ['Bob'], contributionUnit: 'points',
  });
  mockApp.mockReturnValue({
    currentHouseholdId: household.id, currentUser: { userId: 'a' }, repos,
    emitDataChange: jest.fn(), subscribeToDataChanges: () => () => undefined, services: {
      attachments: { isAvailable: () => false }, media: { isAvailable: () => false },
      calendar: { isAvailable: () => false }, notifications: {},
    },
  });
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<TodosScreen />); });
    const button = (id: string) => tree.root.findAllByType(Button).find(node => node.props.testID === id)!;
    await act(async () => { button('todos.newItem').props.onPress(); });
    expect(tree.root.findAllByType(ScrollView)).toHaveLength(1);
    expect(tree.root.findAllByType(KeyboardAvoidingView)).toHaveLength(1);
    expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBe('height');
    const field = (id: string) => tree.root.findAllByType(TextInput).find(node => node.props.testID === id)!;
    act(() => { field('todos.createTitle').props.onChangeText('Courses'); });
    act(() => { tree.root.findByType(ScrollView).props.onScrollBeginDrag({ nativeEvent: {} }); });
    expect(dismiss).toHaveBeenCalledTimes(1);
    act(() => { field('todos.createNotes').props.onChangeText('Pain et café'); });
    await act(async () => { await button('todos.createSubmit').props.onPress(); });
    expect(await repos.todos.getByHousehold(household.id)).toEqual([
      expect.objectContaining({ title: 'Courses', notes: 'Pain et café', status: 'todo' }),
    ]);
  } finally {
    await act(async () => tree.unmount());
    dismiss.mockRestore();
    Object.defineProperty(Platform, 'OS', { value: previousOS, configurable: true });
  }
});


test('todo deletion stays visible and emitted when the native reminder cancellation fails', async () => {
  const repos = createInMemoryRepositories();
  const { household, ownerMember } = await createGroupWithMembers(repos, { name: 'Maison', owner: { userId: 'a', displayName: 'Alice' }, memberNames: ['Bob'] });
  const todo = await repos.todos.create({ householdId: household.id, title: 'À supprimer', kind: 'task', status: 'todo',
    assigneeMemberId: ownerMember.id, beneficiaryMemberIds: [ownerMember.id], dueAt: null, reminderAt: null, notes: '', persistentTaskId: null });
  const emit = jest.fn();
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'a' }, repos,
    emitDataChange: emit, subscribeToDataChanges: () => () => undefined, services: {
      attachments: { isAvailable: () => false }, media: { isAvailable: () => false }, calendar: { isAvailable: () => false },
      notifications: { cancelNotification: jest.fn().mockRejectedValue(new Error('native unavailable')) },
    },
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<TodosScreen />); });
    act(() => tree.root.findAllByType(Button).find(node => node.props.testID === 'todos.delete.0')!.props.onPress());
    const confirm = alert.mock.calls.at(-1)![2]!.find(button => button.style === 'destructive')!.onPress!;
    await act(async () => { await confirm(); });
    expect(await repos.todos.getById(todo.id)).toBeNull();
    expect(JSON.stringify(tree.toJSON())).not.toContain('À supprimer');
    expect(emit).toHaveBeenCalledWith('todo', household.id);
  } finally { if (tree) await act(async () => tree.unmount()); alert.mockRestore(); }
});


test.each([['fr', /1,01\sCHF/, '15/11'], ['en', /CHF\s1\.01/, '11/15']] as const)('todo amounts and dates follow the selected %s language', async (locale, amount, date) => {
  mockLocale = locale;
  const repos = createInMemoryRepositories();
  const { household, ownerMember } = await createGroupWithMembers(repos, { name: 'Maison', owner: { userId: 'a', displayName: 'Alice' }, memberNames: ['Bob'] });
  await repos.todos.create({ householdId: household.id, title: 'Courses prévues', kind: 'expense', status: 'todo',
    assigneeMemberId: ownerMember.id, beneficiaryMemberIds: [ownerMember.id], dueAt: new Date(2030, 10, 15, 12).toISOString(),
    reminderAt: null, notes: '', persistentTaskId: null, expenseAmountMinor: 101, expenseCurrency: 'CHF' });
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'a' }, repos,
    emitDataChange: jest.fn(), subscribeToDataChanges: () => () => undefined, services: {
      attachments: { isAvailable: () => false }, media: { isAvailable: () => false }, calendar: { isAvailable: () => false }, notifications: {},
    },
  });
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<TodosScreen />); });
    const content = JSON.stringify(tree.toJSON());
    expect(content).toMatch(amount);
    expect(content).toContain(date);
    expect(content).toContain('2030');
    expect(content).toContain('12:00');
    expect((await repos.todos.getByHousehold(household.id))[0].expenseAmountMinor).toBe(101);
  } finally { if (tree) await act(async () => tree.unmount()); mockLocale = 'fr'; }
});
