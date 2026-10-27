import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Keyboard, ScrollView, Text } from 'react-native';
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
