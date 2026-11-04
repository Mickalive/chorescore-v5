import { FirebaseMediaGateway } from '../src/infrastructure/firebase/FirebaseMediaGateway';

test('cached Firebase photos authorize against projected metadata without downloading image data again', async () => {
  const calls: URL[] = [];
  const fetchImpl = jest.fn(async (input: any) => {
    const url = new URL(String(input));
    calls.push(url);
    const group = url.pathname.endsWith('/groups/family');
    if (!group) expect(url.searchParams.getAll('mask.fieldPaths')).toEqual(['sha256']);
    const fields = group
      ? { access: { mapValue: { fields: { alice: { mapValue: { fields: { role: { stringValue: 'OWNER' } } } } } } } }
      : { sha256: { stringValue: 'photo-digest' } };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      name: 'projects/test-project/databases/(default)/documents/' + (group ? 'groups/family' : 'groups/family/media/photo'), fields,
    }) } as Response;
  }) as typeof fetch;
  const media = new FirebaseMediaGateway({ projectId: 'test-project', getUid: () => 'alice',
    getAccessToken: async () => 'token', fetchImpl, readCached: async () => 'file://private/photo.jpg' });
  await expect(media.download('family', 'photo')).resolves.toBe('file://private/photo.jpg');
  expect(calls).toHaveLength(2);
  expect(calls[1].pathname).toContain('/media/photo');
});
