import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import AddScreen from '../app/(tabs)/add';
import TodosScreen from '../app/(tabs)/todos';
import { Button } from '../src/ui/components/Button';
import { createInMemoryRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';

const mockApp = jest.fn();
const mockTranslate = (key: string) => key;
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: mockTranslate, locale: 'fr' }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }), useLocalSearchParams: () => ({}) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => children }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-notifications', () => ({}));

test('open forms receive remote todos, categories and renamed members without losing drafts', async () => {
  const repos = createInMemoryRepositories();
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'alice', displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  const listeners = new Set<(type: any, id: string) => void | Promise<void>>();
  const emit = async (type: string, id = household.id) => { await Promise.all([...listeners].map(listener => listener(type, id))); };
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'alice' }, repos,
    subscribeToDataChanges: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); },
    emitDataChange: emit, services: { attachments: { isAvailable: () => false }, media: { isAvailable: () => false }, calendar: { isAvailable: () => false } },
  });
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<><AddScreen /><TodosScreen /></>); });
    const field = (id: string) => tree.root.findAllByType(TextInput).find(node => node.props.testID === id)!;
    act(() => field('add.taskLabel').props.onChangeText('Mon brouillon'));
    const category = await repos.categories.create({ householdId: household.id, name: 'Cuisine distante', defaultTaskRatio: null });
    await act(async () => emit('category'));
    expect(JSON.stringify(tree.toJSON())).toContain('Cuisine distante');
    const todo = await repos.todos.create({ householdId: household.id, title: 'Todo reçu distant', kind: 'task', status: 'todo',
      assigneeMemberId: ownerMember.id, beneficiaryMemberIds: [ownerMember.id, namedMembers[0].id],
      dueAt: null, reminderAt: null, notes: '', persistentTaskId: null, categoryId: category.id });
    await act(async () => emit('todo'));
    expect(JSON.stringify(tree.toJSON())).toContain('Todo reçu distant');
    await repos.todos.update(todo.id, { status: 'completed', completedAt: new Date().toISOString() });
    await act(async () => emit('todo'));
    expect(JSON.stringify(tree.toJSON())).not.toContain('Todo reçu distant');
    act(() => tree.root.findAllByType(Button).find(node => node.props.testID === 'todos.newItem')!.props.onPress());
    act(() => field('todos.createTitle').props.onChangeText('Mon todo brouillon'));
    await repos.members.update(namedMembers[0].id, { name: 'Robert distant' });
    await act(async () => emit('member'));
    expect(JSON.stringify(tree.toJSON())).toContain('Robert distant');
    expect(field('add.taskLabel').props.value).toBe('Mon brouillon');
    expect(field('todos.createTitle').props.value).toBe('Mon todo brouillon');
    expect(listeners.size).toBe(2);
  } finally { if (tree) await act(async () => tree.unmount()); }
  expect(listeners.size).toBe(0);
});

test('two independently mounted forms never reuse a photo id at the same clock instant', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1800000000000);
  const repos = createInMemoryRepositories();
  const { household } = await createGroupWithMembers(repos, {
    name: 'Maison', owner: { userId: 'alice', displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  let image = 0;
  mockApp.mockReturnValue({ currentHouseholdId: household.id, currentUser: { userId: 'alice' }, repos,
    subscribeToDataChanges: () => () => undefined, emitDataChange: jest.fn(),
    services: { media: { isAvailable: () => false }, calendar: { isAvailable: () => false },
      attachments: { isAvailable: () => true, pickPhoto: async () => ({ localUri: 'file:///picked/photo.png' }),
        save: async () => ({ ref: `file:///private/photo-${++image}.png`, mimeType: 'image/png', byteSize: 10 }) },
    },
  });
  try {
    for (let runtime = 0; runtime < 2; runtime++) {
      let tree!: renderer.ReactTestRenderer;
      try {
        await act(async () => { tree = renderer.create(<AddScreen />); });
        const field = (id: string) => tree.root.findAllByType(TextInput).find(node => node.props.testID === id)!;
        const button = (id: string) => tree.root.findAllByType(Button).find(node => node.props.testID === id)!;
        act(() => field('add.taskLabel').props.onChangeText(`Photo ${runtime}`));
        act(() => field('add.taskValue').props.onChangeText('2'));
        await act(async () => { await button('add.taskPhotoButton').props.onPress(); });
        await act(async () => { await button('add.taskSubmit').props.onPress(); });
      } finally { if (tree) await act(async () => tree.unmount()); }
    }
    const entries = await repos.contributions.getByHousehold(household.id);
    expect(entries).toHaveLength(2);
    const photos = entries.map(entry => entry.attachments![0]);
    expect(new Set(photos.map(photo => photo.id)).size).toBe(2);
    expect(new Set(photos.map(photo => photo.ref)).size).toBe(2);
  } finally { clock.mockRestore(); }
});
