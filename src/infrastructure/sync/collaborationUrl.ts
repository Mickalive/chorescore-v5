/** Never send Firebase bearer tokens to a plaintext remote authority. */
export function collaborationBaseUrl(value: string): string {
  const base = value.trim().replace(/\/+$/, '');
  if (!base) return '';
  const url = new URL(base);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Collaboration requires HTTPS (HTTP is allowed only on loopback for local tests)');
  }
  return base;
}
