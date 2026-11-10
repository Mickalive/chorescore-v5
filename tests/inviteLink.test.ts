import {
  buildInviteLink,
  buildInviteWebLink,
  isValidInviteToken,
} from '../src/features/invitations/inviteLink';

const serverToken = 'A'.repeat(43);
const localToken = '0123456789abcdef01234567';

test('server and local invitation tokens produce an app deep link', () => {
  expect(buildInviteLink(serverToken)).toBe(`chorescore://join/${serverToken}`);
  expect(buildInviteLink(localToken)).toBe(`chorescore://join/${localToken}`);
  expect(buildInviteWebLink(serverToken)).toBe(
    `https://chorescore.app/join/${serverToken}`,
  );
});

test.each([
  '',
  'short',
  '../join/token',
  'token/../../evil',
  'token with spaces',
  'javascript:alert(1)',
  'A'.repeat(129),
])('invalid invitation token is never interpolated into a URL: %s', (token) => {
  expect(isValidInviteToken(token)).toBe(false);
  expect(() => buildInviteLink(token)).toThrow('Invalid invitation token');
  expect(() => buildInviteWebLink(token)).toThrow('Invalid invitation token');
});
