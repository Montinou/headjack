const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The one transport rule for server-owned URLs: HTTPS, or HTTP only on a loopback host.
export function isSecureUrl(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

// The canonical text of a URL for comparison: lowercase host, no default port, no trailing slash, query or fragment; a path
// is kept. null when the value is not a URL.
export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

// Whether `resource` names the API of the Headjack server at `url`, whatever the case, default port or trailing slash.
export function isApiResourceOf(resource, url) {
  const base = canonicalUrl(url);
  return base !== null && canonicalUrl(resource) === `${base}/api`;
}

// A server-owned URL: HTTPS (HTTP only on loopback), no credentials, query or fragment, already canonical. `origin` demands
// a bare origin; `resource` demands a canonical URL whose path ends with `suffix` ('/mcp' or '/api').
export function trustedUrl(value, name, { origin = false, resource = false, suffix } = {}) {
  try {
    if (typeof value !== 'string' || !value) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash
      || !isSecureUrl(url)
      || (origin ? url.origin !== value : url.href !== value)
      || (resource && (!suffix || !url.pathname.endsWith(suffix)))) throw new Error();
    return value;
  } catch {
    throw new Error(`${name} must contain an explicit ${origin ? 'origin' : 'canonical URL'} using HTTPS (HTTP loopback allowed)`);
  }
}

// REST OAuth configuration. Unset means REST accepts no OAuth access token; API keys and sessions are unaffected.
// Configuration is server-owned. Never derive these values from request headers.
export function loadApiOAuthConfig(env) {
  if (!env.HEADJACK_API_RESOURCE_URL || !env.HEADJACK_AUTH_SERVER_URL) return null;
  const resource = trustedUrl(env.HEADJACK_API_RESOURCE_URL, 'HEADJACK_API_RESOURCE_URL', { resource: true, suffix: '/api' });
  const issuer = trustedUrl(env.HEADJACK_AUTH_SERVER_URL, 'HEADJACK_AUTH_SERVER_URL', { origin: true });
  return { resource, issuer, cliClientId: env.HEADJACK_CLI_CLIENT_ID || null };
}
