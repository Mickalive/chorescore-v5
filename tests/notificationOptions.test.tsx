import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Switch } from 'react-native';
import GeneralOptionsScreen from '../app/general-options';
import { Button } from '../src/ui/components/Button';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => children }));
const mockApp = jest.fn();
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
const mockTranslate = (key: string, values?: { title?: string }) => values?.title ?? key;
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: mockTranslate, locale: 'fr', setLocale: jest.fn() }) }));

const notifications = {
  isAvailable: () => true,
  getEnabled: jest.fn(),
  setEnabled: jest.fn(),
};
const getByHousehold = jest.fn();
let tree: renderer.ReactTestRenderer;

beforeEach(() => {
  jest.clearAllMocks();
  notifications.getEnabled.mockResolvedValue(false);
  notifications.setEnabled.mockResolvedValue(undefined);
  mockApp.mockReturnValue({
    currentUser: null, signOut: jest.fn(), households: [{ id: 'h1' }, { id: 'h2' }],
    repos: { todos: { getByHousehold } }, services: { notifications },
  });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });

const reminderSwitch = () => tree.root.findAllByType(Switch).find(node => node.props.testID === 'options.remindersEnabled')!;

test('enabling restores future unfinished reminders across groups and excludes completed items', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  getByHousehold.mockImplementation(async (id: string) => id === 'h1' ? [
    { id: 'pending', title: 'Courses', notes: 'Pain', status: 'todo', reminderAt: future },
    { id: 'completed', title: 'Done', status: 'completed', reminderAt: future },
    { id: 'past', title: 'Past', status: 'todo', reminderAt: '2000-01-01T00:00:00Z' },
  ] : [{ id: 'working', title: 'Ménage', status: 'in-progress', reminderAt: future }]);
  await act(async () => { tree = renderer.create(<GeneralOptionsScreen />); });
  expect(reminderSwitch().props.value).toBe(false);
  await act(async () => { await reminderSwitch().props.onValueChange(true); });
  expect(getByHousehold.mock.calls).toEqual([['h1'], ['h2']]);
  expect(notifications.setEnabled).toHaveBeenCalledWith(true, [
    { title: 'Courses', body: 'Pain', scheduledAt: future, data: { todoId: 'pending' } },
    { title: 'Ménage', body: 'todos.reminderNotificationBody', scheduledAt: future, data: { todoId: 'working' } },
  ]);
  expect(reminderSwitch().props.value).toBe(true);
});

test('disabling avoids loading todo history and a failed toggle shows the persisted state', async () => {
  notifications.getEnabled.mockResolvedValue(true);
  await act(async () => { tree = renderer.create(<GeneralOptionsScreen />); });
  await act(async () => { await reminderSwitch().props.onValueChange(false); });
  expect(notifications.setEnabled).toHaveBeenCalledWith(false, []);
  expect(getByHousehold).not.toHaveBeenCalled();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  notifications.setEnabled.mockRejectedValue(new Error('denied'));
  notifications.getEnabled.mockResolvedValue(false);
  getByHousehold.mockResolvedValue([]);
  await act(async () => { await reminderSwitch().props.onValueChange(true); });
  expect(reminderSwitch().props.value).toBe(false);
  expect(alert).toHaveBeenCalledWith('state.error', 'options.notificationsError');
  notifications.setEnabled.mockResolvedValue(undefined);
  const retry = tree.root.findAllByType(Button).find(button => button.props.title === 'action.retry')!;
  await act(async () => { await retry.props.onPress(); });
  expect(notifications.setEnabled).toHaveBeenLastCalledWith(false, []);
  expect(tree.root.findAllByType(Button).some(button => button.props.title === 'action.retry')).toBe(false);
  alert.mockRestore();
});
