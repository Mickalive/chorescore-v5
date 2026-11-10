import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Keyboard, ScrollView, Text } from 'react-native';
import { DateTimeField } from '../src/ui/components/DateTimeField';
import { Button } from '../src/ui/components/Button';
import { ScreenContainer } from '../src/ui/components/ScreenContainer';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

test('dragging a form explicitly dismisses the native keyboard', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<ScreenContainer><Text>Form</Text></ScreenContainer>); });
    act(() => tree.root.findByType(ScrollView).props.onScrollBeginDrag({ nativeEvent: {} }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => tree.unmount());
    dismiss.mockRestore();
  }
});


jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'fr' }) }));

test('date dialog dismisses the keyboard on drag and confirms edited local date and time', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const change = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<DateTimeField label="Rappel" value={null} onChange={change} testID="reminder" />); });
    const button = (id: string) => tree.root.findAllByType(Button).find(node => node.props.testID === id)!;
    act(() => button('reminder').props.onPress());
    const scroll = tree.root.findByType(ScrollView);
    act(() => scroll.props.onScrollBeginDrag({ nativeEvent: {} }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    const { TextInput } = require('react-native');
    const field = (id: string) => tree.root.findAllByType(TextInput).find(node => node.props.testID === id)!;
    act(() => field('reminder.date').props.onChangeText('2026-10-28'));
    act(() => field('reminder.time').props.onChangeText('12:00'));
    act(() => button('reminder.confirm').props.onPress());
    expect(change).toHaveBeenCalledTimes(1);
    const value = change.mock.calls[0][0] as Date;
    expect([value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes()]).toEqual([2026, 9, 28, 12, 0]);
  } finally {
    if (tree) await act(async () => tree.unmount());
    dismiss.mockRestore();
  }
});
