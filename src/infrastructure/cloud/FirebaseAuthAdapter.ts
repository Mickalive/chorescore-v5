/** Firebase Auth REST + genuine native Google Sign-In. Tokens stay in SecureStore.
 * Public Firebase API keys identify a project; they are not authorization.
 * All cloud operations must verify the Firebase ID token on the authority.
 */
import { AuthGateway, AuthSessionToken, AuthUser, SecureStorageGateway } from '../../application/ports';
import { authUserFromSession } from '../local/e2eAuthConfig';

const SESSION_KEY = 'chorescore.firebase.session';
/** Public project id confirmed by the owner; override with the build variable. */
export const DEFAULT_FIREBASE_PROJECT_ID = 'chorescore-a75b1';
export interface FirebaseAuthConfig { apiKey: string; projectId: string; googleWebClientId: string; }
export function firebaseAuthConfig(): FirebaseAuthConfig | null {
  const apiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID;
  const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  return apiKey && googleWebClientId ? { apiKey, projectId, googleWebClientId } : null;
}

export class FirebaseAuthAdapter implements AuthGateway {
  private session: AuthSessionToken | null = null;
  private listeners = new Set<(user: AuthUser | null) => void>();
  private storageWrites: Promise<void> = Promise.resolve();
  private generation = 0;
  private refreshing: Promise<string> | null = null;
  constructor(private config: FirebaseAuthConfig, private store: SecureStorageGateway) {}
  isAvailable() { return true; }
  getCurrentUserId() { return this.session?.userId ?? null; }
  getCurrentUser() { return this.session ? authUserFromSession(this.session) : null; }
  onAuthStateChanged(callback: (user: AuthUser | null) => void) {
    this.listeners.add(callback); callback(this.getCurrentUser());
    return () => { this.listeners.delete(callback); };
  }
  private async request(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  }
  private notify() { for (const listener of this.listeners) listener(this.getCurrentUser()); }
  async signInWithEmail(): Promise<null> { throw new Error('Email sign-in is not supported'); }
  async signInWithApple(): Promise<null> { return null; }
  async signInWithFacebook(): Promise<null> { return null; }

  async signInWithGoogle(): Promise<AuthUser | null> {
    const generation = this.generation;
    // Lazy import: local builds, Node tests and web do not require native Google services.
    const { GoogleSignin } = require('@react-native-google-signin/google-signin') as typeof import('@react-native-google-signin/google-signin');
    GoogleSignin.configure({ webClientId: this.config.googleWebClientId });
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const result = await GoogleSignin.signIn();
    if (result.type === 'cancelled') return null;
    const { idToken } = await GoogleSignin.getTokens();
    if (!idToken) throw new Error('Google did not return an ID token');
    const response = await this.request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(this.config.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestUri: `https://${this.config.projectId}.firebaseapp.com`, returnSecureToken: true,
        postBody: `id_token=${encodeURIComponent(idToken)}&providerId=google.com` }),
    });
    if (!response.ok) throw new Error(`Firebase sign-in failed (${response.status})`);
    const data = await response.json();
    if (!data.localId || !data.idToken || !data.refreshToken || !(Number.isFinite(Number(data.expiresIn)) && Number(data.expiresIn) > 0)) {
      throw new Error('Invalid Firebase session response');
    }
    const token: AuthSessionToken = { userId: data.localId, accessToken: data.idToken,
      refreshToken: data.refreshToken, provider: 'google', displayName: data.displayName || '',
      email: data.email || '', expiresAt: new Date(Date.now() + Number(data.expiresIn) * 1000).toISOString() };
    if (generation !== this.generation) throw new Error('Sign-in cancelled');
    await this.persistSession(token);
    if (generation !== this.generation) throw new Error('Sign-in cancelled');
    this.session = token; this.notify();
    return this.getCurrentUser();
  }

  async persistSession(token: AuthSessionToken) {
    const write = this.storageWrites.then(() => this.store.setItem(SESSION_KEY, JSON.stringify(token)));
    this.storageWrites = write.catch(() => undefined);
    await write;
  }
  async restoreSession(): Promise<AuthSessionToken | null> {
    const raw = await this.store.getItem(SESSION_KEY);
    if (!raw) return null;
    const token = JSON.parse(raw) as AuthSessionToken;
    if (token.provider !== 'google' || !token.userId || !token.refreshToken || !token.accessToken ||
        !Number.isFinite(Date.parse(token.expiresAt))) throw new Error('Invalid stored Firebase session');
    // Offline startup reads local data even if refreshing requires connectivity.
    this.session = token; this.notify(); return token;
  }
  async clearSession() {
    const write = this.storageWrites.then(() => this.store.deleteItem(SESSION_KEY));
    this.storageWrites = write.catch(() => undefined);
    await write;
  }
  async signOut() {
    this.generation += 1; this.session = null; this.notify();
    await this.clearSession();
  }

  /** Coalesce refreshes; never send an expired ID token as cloud authorization. */
  async getIdToken(): Promise<string> {
    if (!this.session) throw new Error('Authentication required');
    if (Date.parse(this.session.expiresAt) > Date.now() + 60_000) return this.session.accessToken;
    if (this.refreshing) return this.refreshing;
    const previous = this.session;
    this.refreshing = (async () => {
      const response = await this.request(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.config.apiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(previous.refreshToken!)}`,
      });
      if (!response.ok) throw new Error(`Firebase token refresh failed (${response.status})`);
      const data = await response.json();
      if (!data.id_token || !data.refresh_token || data.user_id !== previous.userId ||
          !(Number.isFinite(Number(data.expires_in)) && Number(data.expires_in) > 0)) throw new Error('Invalid Firebase refresh response');
      // A refresh that finishes after sign-out must not resurrect the session.
      if (this.session !== previous) throw new Error('Session changed during refresh');
      const token = { ...previous, accessToken: data.id_token, refreshToken: data.refresh_token,
        expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() };
      await this.persistSession(token);
      if (this.session !== previous) throw new Error('Session changed during refresh');
      this.session = token;
      return token.accessToken;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
