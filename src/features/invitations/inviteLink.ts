/**
 * Invitation links that a real Android/iOS build can open.
 *
 * The app registers the `chorescore://` scheme (and the HTTPS `/join` path in
 * app.json). A link is only produced from a bounded, opaque token; arbitrary
 * text is never interpolated into a URL.
 */
export const INVITE_SCHEME = 'chorescore';
export const INVITE_HTTPS_BASE = 'https://chorescore.app/join';
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidInviteToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN.test(token);
}

/** Deep link that opens the installed app directly (works without a domain). */
export function buildInviteLink(token: string): string {
  if (!isValidInviteToken(token)) throw new Error('Invalid invitation token');
  return `${INVITE_SCHEME}://join/${token}`;
}

/** Hosted fallback for environments where the ChoreScore domain is deployed. */
export function buildInviteWebLink(token: string): string {
  if (!isValidInviteToken(token)) throw new Error('Invalid invitation token');
  return `${INVITE_HTTPS_BASE}/${token}`;
}
