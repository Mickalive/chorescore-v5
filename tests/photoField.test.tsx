/**
 * A photo received from another device only carries `media:<remoteRef>` until
 * its private file is downloaded. Rendering that opaque reference immediately
 * makes Android's Image fail and would keep the photo stuck as "missing".
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Image, Text } from 'react-native';
import { PhotoField } from '../src/features/entries/PhotoField';
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
