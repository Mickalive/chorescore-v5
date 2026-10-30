/**
 * A photo received from another device only carries `media:<remoteRef>` until
 * its private file is downloaded. Rendering that opaque reference immediately
 * makes Android's Image fail and would keep the photo stuck as "missing".
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { ActivityIndicator, Image, Text, TouchableOpacity } from 'react-native';
import { PhotoField } from '../src/features/entries/PhotoField';
import { Button } from '../src/ui/components/Button';
import type { Attachment } from '../src/domain/entities';

const download = jest.fn();
const mockUseApp = jest.fn();

jest.mock('../src/features/app/AppContext', () => ({
  useApp: () => mockUseApp(),
}));

jest.mock('../src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

function remotePhoto(): Attachment {
  return {
    id: 'att-remote',
    kind: 'photo',
    ref: 'media:att-remote',
    remoteRef: 'att-remote',
    mimeType: 'image/jpeg',
    byteSize: 12,
    createdAt: '2026-10-26T10:00:00.000Z',
  } as Attachment;
}

beforeEach(() => {
  download.mockReset();
  mockUseApp.mockReturnValue({
    currentHouseholdId: 'household-1',
    services: {
      media: {
        isAvailable: () => true,
        download: (...args: unknown[]) => download(...args),
      },
    },
  });
});

test('preview is ready only after its own image loads and ignores an older preview callback', async () => {
  const photos = ['first','second'].map(id => ({ ...remotePhoto(), id, ref: `file:///private/${id}.png`, remoteRef: undefined }));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree=renderer.create(<PhotoField attachments={photos} available onAdd={() => {}} onRemove={() => {}} />); });
  const open = (index: number) => tree.root.findAllByType(TouchableOpacity).filter(node => node.props.accessibilityLabel==='photo.openPreview')[index].props.onPress();
  await act(async () => open(0));
  const oldLoad=tree.root.findByProps({ testID:'photo.preview.loading' }).props.onLoad;
  expect(tree.root.findAllByProps({ testID:'photo.preview.loaded' })).toHaveLength(0);
  await act(async () => tree.root.findAllByType(Button).find(node => node.props.title==='action.close')!.props.onPress());
  await act(async () => open(1));
  await act(async () => oldLoad());
  expect(tree.root.findAllByProps({ testID:'photo.preview.loaded' })).toHaveLength(0);
  const image=tree.root.findByProps({ testID:'photo.preview.loading' });
  await act(async () => image.props.onLoad());
  expect(tree.root.findByProps({ testID:'photo.preview.loaded' }).props.source.uri).toBe('file:///private/second.png');
  await act(async () => tree.unmount());
});

test('a preview decoding failure displays an error and never reports a loaded photo', async () => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree=renderer.create(<PhotoField attachments={[{ ...remotePhoto(), ref:'file:///private/broken.png', remoteRef:undefined }]}
    available onAdd={() => {}} onRemove={() => {}} />); });
  await act(async () => tree.root.findAllByType(TouchableOpacity).find(node => node.props.accessibilityLabel==='photo.openPreview')!.props.onPress());
  const image=tree.root.findByProps({ testID:'photo.preview.loading' });
  await act(async () => image.props.onError());
  expect(tree.root.findAllByType(Text).some(node => node.props.children==='add.photoMissing')).toBe(true);
  expect(tree.root.findAllByProps({ testID:'photo.preview.loaded' })).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a failed cloud recovery ends preview loading with an error', async () => {
  download.mockRejectedValue(new Error('offline'));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree=renderer.create(<PhotoField attachments={[{ ...remotePhoto(), ref:'file:///private/missing.png' }]}
    available onAdd={() => {}} onRemove={() => {}} />); });
  await act(async () => tree.root.findAllByType(TouchableOpacity).find(node => node.props.accessibilityLabel==='photo.openPreview')!.props.onPress());
  await act(async () => tree.root.findByProps({ testID:'photo.preview.loading' }).props.onError());
  expect(download).toHaveBeenCalledWith('household-1','att-remote');
  expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
  expect(tree.root.findAllByType(Text).filter(node => node.props.children==='add.photoMissing')).toHaveLength(2);
  await act(async () => tree.unmount());
});

test('received photo is not handed to Image before the private file exists', async () => {
  let finish: (uri: string) => void = () => undefined;
  download.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));

  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <PhotoField attachments={[remotePhoto()]} available onAdd={() => undefined} onRemove={() => undefined} />,
    );
  });

  expect(download).toHaveBeenCalledWith('household-1', 'att-remote');
  expect(tree.root.findAllByType(Image)).toHaveLength(0);
  expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'state.loading')).toBe(true);

  await act(async () => { finish('file:///private/cache/att-remote.jpg'); });
  expect(tree.root.findAllByType(Image).map((node) => node.props.source)).toEqual([
    { uri: 'file:///private/cache/att-remote.jpg' },
  ]);
});

test('a local photo keeps its own file reference and a failed download is shown honestly', async () => {
  download.mockRejectedValue(new Error('offline'));

  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <PhotoField
        attachments={[
          { ...remotePhoto(), id: 'att-local', ref: 'file:///local/photo.jpg', remoteRef: undefined },
          remotePhoto(),
        ]}
        available
        onAdd={() => undefined}
        onRemove={() => undefined}
      />,
    );
  });

  expect(tree.root.findAllByType(Image).map((node) => node.props.source)).toEqual([
    { uri: 'file:///local/photo.jpg' },
  ]);
  expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'add.photoMissing')).toBe(true);
});

test('an uploaded photo keeps its private local file available offline without downloading it again', async () => {
  download.mockRejectedValue(new Error('offline'));
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PhotoField attachments={[{ ...remotePhoto(), ref: 'file:///private/photo.jpg' }]}
      available onAdd={() => undefined} onRemove={() => undefined} />);
  });
  expect(download).not.toHaveBeenCalled();
  expect(tree.root.findByType(Image).props.source).toEqual({ uri: 'file:///private/photo.jpg' });
  await act(async () => tree.unmount());
});

test('a missing local copy falls back to its authorized cloud photo', async () => {
  download.mockResolvedValue('file:///cache/restored.jpg');
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PhotoField attachments={[{ ...remotePhoto(), ref: 'file:///missing.jpg' }]}
      available onAdd={() => undefined} onRemove={() => undefined} />);
  });
  await act(async () => { tree.root.findByType(Image).props.onError(); });
  expect(download).toHaveBeenCalledWith('household-1', 'att-remote');
  expect(tree.root.findByType(Image).props.source).toEqual({ uri: 'file:///cache/restored.jpg' });
  await act(async () => tree.unmount());
});

test('a received photo can be retried after reconnecting without reopening the entry', async () => {
  download.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('file:///cache/online.jpg');
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PhotoField attachments={[remotePhoto()]} available onAdd={() => undefined} onRemove={() => undefined} />);
  });
  const retry = tree.root.findAllByType(Button).find(button => button.props.title === 'action.retry')!;
  expect(retry).toBeDefined();
  await act(async () => retry.props.onPress());
  expect(download).toHaveBeenCalledTimes(2);
  expect(tree.root.findByType(Image).props.source).toEqual({ uri: 'file:///cache/online.jpg' });
  await act(async () => tree.unmount());
});

test('several remote photos download once each, and resolved files never cross group boundaries', async () => {
  download.mockImplementation(async (group, ref) => `file:///cache/${group}/${ref}.jpg`);
  const attachments = [remotePhoto(), { ...remotePhoto(), id: 'second', remoteRef: 'second', ref: 'media:second' }];
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PhotoField attachments={attachments} available onAdd={() => undefined} onRemove={() => undefined} />);
  });
  expect(download).toHaveBeenCalledTimes(2);
  const app = mockUseApp();
  mockUseApp.mockReturnValue({ ...app, currentHouseholdId: 'household-2' });
  await act(async () => {
    tree.update(<PhotoField attachments={attachments} available onAdd={() => undefined} onRemove={() => undefined} />);
  });
  expect(download).toHaveBeenCalledTimes(4);
  expect(tree.root.findAllByType(Image).map(image => image.props.source.uri)).toEqual([
    'file:///cache/household-2/att-remote.jpg', 'file:///cache/household-2/second.jpg',
  ]);
  await act(async () => tree.unmount());
});
