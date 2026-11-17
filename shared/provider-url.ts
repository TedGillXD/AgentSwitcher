/** Shared by profile storage, model discovery, and the credential proxy. */
export function normalizeProviderBaseUrl(input: string): string {
  const url = new URL(input);
  // Respect the explicitly configured transport, including HTTP intranet gateways.
  // Credentials belong in the Authorization header, never in the URL.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The provider URL must use HTTP or HTTPS without embedded credentials, query parameters, or fragments.');
  }
  return url.href.replace(/\/+$/, '');
}
