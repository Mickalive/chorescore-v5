import { verify } from 'node:crypto';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Firebase ID-token verification with Google's signed X.509 certificates.
 * Production never accepts emulator/unsigned tokens or caller-supplied keys. */
export class FirebaseTokenVerifier {
  private cache: { until: number; certificates: Record<string, string> } | null = null;
  constructor(private projectId: string,
    private certificateSource?: () => Promise<Record<string, string>>) {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) throw new Error('Invalid Firebase project ID');
  }
  private async certificates(): Promise<Record<string, string>> {
    if (this.certificateSource) return this.certificateSource();
    if (this.cache && this.cache.until > Date.now()) return this.cache.certificates;
    let response: Response;
    try { response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
      { signal: AbortSignal.timeout(15000) }); }
    catch { throw new HttpError(503, 'Identity service unavailable'); }
    if (!response.ok) throw new HttpError(503, 'Identity service unavailable');
    const certificates = await response.json() as Record<string, string>;
    const ttl = Math.min(3600, Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 300));
    this.cache = { until: Date.now() + ttl * 1000, certificates };
    return certificates;
  }
  async verify(authorization?: string): Promise<string> {
    if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
    const token = authorization.slice(7);
    if (token.length > 16384) throw new HttpError(401, 'Invalid identity token');
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      const now = Math.floor(Date.now() / 1000);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
          claims.aud !== this.projectId || claims.iss !== `https://securetoken.google.com/${this.projectId}` ||
          typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 ||
          !Number.isInteger(claims.exp) || claims.exp <= now ||
          !Number.isInteger(claims.iat) || claims.iat < 0 || claims.iat > now + 30 ||
          !Number.isInteger(claims.auth_time) || claims.auth_time < 0 || claims.auth_time > now + 30) throw new Error();
      const certificates = await this.certificates();
      const certificate = Object.hasOwn(certificates,header.kid) ? certificates[header.kid] : null;
      if (!certificate || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), certificate,
        Buffer.from(parts[2], 'base64url'))) throw new Error();
      return claims.sub;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, 'Invalid identity token');
    }
  }
}
