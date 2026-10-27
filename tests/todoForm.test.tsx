import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput } from 'react-native';
import TodosScreen from '../app/(tabs)/todos';
import { Button } from '../src/ui/components/Button';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

const mockApp = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
const mockTranslate = (key: string) => key;
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: mockTranslate, locale: 'fr' }) }));
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
    emitDataChange: jest.fn(), services: {
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
