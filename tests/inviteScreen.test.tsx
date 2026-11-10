import React from 'react';
import renderer, { act } from 'react-test-renderer';
import InviteScreen from '../app/invite';
import { Button } from '../src/ui/components/Button';

const mockApp = jest.fn();
const mockRouter = { back: jest.fn() };
const mockTranslate = (key: string) => key;
jest.mock('../src/features/app/AppContext', () => ({ useApp: () => mockApp() }));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: mockTranslate, locale: 'fr' }) }));
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ memberId: 'named' }), useRouter: () => mockRouter }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => children }));

function fixture() {
  const members = [{ id: 'named', householdId: 'group', name: 'Camille', userId: null as string | null }];
  const invitations: any[] = [];
  let changed: (type: string, groupId: string) => void = () => {};
  const app = {
    currentHouseholdId: 'group', currentUser: { userId: 'owner' },
    subscribeToDataChanges: (callback: typeof changed) => { changed = callback; return () => {}; },
    repos: {
      households: { getById: jest.fn(async () => ({ id: 'group', name: 'Maison', ownerId: 'owner' })) },
      members: { getByHousehold: jest.fn(async () => members) },
      invitations: {
        getByHousehold: jest.fn(async () => invitations),
        create: jest.fn(async data => { const row = { ...data, id: 'inv', createdAt: new Date().toISOString() }; invitations.push(row); return row; }),
      },
    },
    services: {
      sync: { isAvailable: () => true, createInvitation: jest.fn(async () => ({ token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00Z' })) },
      share: { share: jest.fn(async () => {}) },
    },
  };
  return { app, members, invitations, change: () => changed('member', 'group') };
}
function createButton(tree: renderer.ReactTestRenderer) {
  return tree.root.findAllByType(Button).find(button => button.props.title === 'invite.createTargetedLink')!;
}

test('resharing an unexpired server invitation reuses its token without another server request', async () => {
  const { app, invitations } = fixture();
  invitations.push({ id: 'inv', status: 'pending', invitedByUserId: 'owner', targetMemberId: 'named',
    linkToken: 'B'.repeat(43), expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
  mockApp.mockReturnValue(app);
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<InviteScreen />); });
  await act(async () => createButton(tree).props.onPress());
  expect(app.services.sync.createInvitation).not.toHaveBeenCalled();
  expect(app.services.share.share).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('B'.repeat(43)) }));
  await act(async () => tree.unmount());
});

test('a remotely linked member immediately loses pending links and cannot be invited again', async () => {
  const { app, invitations, members, change } = fixture();
  invitations.push({ id: 'inv', status: 'pending', invitedByUserId: 'owner', targetMemberId: 'named',
    linkToken: 'B'.repeat(43), expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' });
  mockApp.mockReturnValue(app);
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<InviteScreen />); });
  expect(JSON.stringify(tree.toJSON())).toContain('invite.pending');
  members[0] = { ...members[0], userId: 'joined-user' };
  await act(async () => change());
  expect(JSON.stringify(tree.toJSON())).not.toContain('invite.pending');
  expect(createButton(tree).props.disabled).toBe(true);
  await act(async () => tree.unmount());
});

test('two taps before rerender issue a single authoritative invitation and share one link', async () => {
  const { app } = fixture();
  let finish!: (value: { token: string; expiresAt: string }) => void;
  app.services.sync.createInvitation.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  mockApp.mockReturnValue(app);
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<InviteScreen />); });
  const press = createButton(tree).props.onPress;
  await act(async () => { void press(); void press(); });
  expect(app.services.sync.createInvitation).toHaveBeenCalledTimes(1);
  await act(async () => finish({ token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00Z' }));
  expect(app.repos.invitations.create).toHaveBeenCalledTimes(1);
  expect(app.services.share.share).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});
