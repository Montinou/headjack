import { ForbiddenError } from './errors.mjs';
import { loadApiOAuthConfig } from './oauth-config.mjs';
import { OAT_BEARER, admitClerkUser, verifyResourceGrant } from './oauth-grant.mjs';

// OAuth access tokens never go through authenticateRequest: a JWT-format one would be verified locally, with no audience
// and no revocation check. Opaque `oat_` tokens take the resource-bound path below; every other bearer is rejected.
const ACCEPTED_TOKENS = ['session_token', 'api_key'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A request that only reads: a read method, or POST /api/search, whose query travels in the body so it stays out of URLs
// and logs. It needs skills:read and, for a cookie session, no authorized Origin. Every other POST stays a write.
const SEARCH_PATH = '/api/search';
const isRead = (req) => READ_METHODS.has(req.method) || (req.method === 'POST' && new URL(req.url).pathname === SEARCH_PATH);

const invalidOrigin = (v) => {
  try {
    const u = new URL(v);
    return u.origin !== v || !['https:', 'http:'].includes(u.protocol)
      || (u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname));
  } catch { return true; }
};

// Explicit configuration, never derived from a client-controlled Host/Origin header. On Preview, Vercel's server-set
// deployment and branch hosts are trusted too, and the configured list may be empty; elsewhere it may not.
export function clerkAuthorizedParties(env) {
  const configured = (env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((v) => v.trim());
  const preview = env.VERCEL_ENV === 'preview';
  const values = preview && configured.length === 1 && configured[0] === '' ? [] : configured;
  if (preview) {
    for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) if (host) values.push(`https://${host}`);
  }
  if (!values.length || values.some(invalidOrigin)) {
    throw new Error('CLERK_AUTHORIZED_PARTIES must contain explicit HTTPS origins (HTTP localhost allowed)');
  }
  return [...new Set(values)];
}

// One online verification against the REST resource (HEADJACK_API_RESOURCE_URL): an MCP token (audience /mcp) is refused
// here. Without the REST OAuth configuration every OAuth token is refused. Outages are a sanitized 500.
async function resolveOAuthToken(req, bearer, { getClient, env }) {
  let config;
  try {
    config = loadApiOAuthConfig(env);
  } catch {
    return null;
  }
  if (!config) return null;
  let client;
  try {
    client = await getClient();
  } catch {
    throw new Error('identity service unavailable');
  }
  const grant = await verifyResourceGrant(client, { token: bearer, resource: config.resource });
  if (!grant) return null;
  if (!grant.scopes.includes(isRead(req) ? 'skills:read' : 'skills:write')) {
    throw new ForbiddenError('missing required skill scope');
  }
  const refId = await admitClerkUser(client, grant.userId);
  return refId ? { kind: 'user', refId, via: 'clerk-oauth_token' } : null;
}

// Clerk remains the only user/profile store. Each request validates the credential and current account state;
// only the immutable namespaced user id is synchronized into owners by createIdentity/resolve_owner.
// SDK calls are injected so tests can isolate remote I/O without replacing the DB/RLS boundary.
export function clerkIdentityResolver({ getClient, enabled, env }) {
  return async (req) => {
    if (!await enabled()) return null;
    const authorizedParties = clerkAuthorizedParties(env);
    const bearer = OAT_BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
    if (bearer) return resolveOAuthToken(req, bearer, { getClient, env });
    try {
      const client = await getClient();
      const state = await client.authenticateRequest(req, { acceptsToken: ACCEPTED_TOKENS, authorizedParties });
      if (!state.isAuthenticated) return null;
      const auth = state.toAuth();
      if (!ACCEPTED_TOKENS.includes(auth.tokenType) || !/^user_[A-Za-z0-9]+$/.test(auth.userId ?? '')) return null;

      const read = isRead(req);
      if (auth.tokenType !== 'session_token') {
        if (!auth.scopes?.includes(read ? 'skills:read' : 'skills:write')) throw new ForbiddenError('missing required skill scope');
      } else {
        // Cookie authentication must not turn cross-origin form submissions into writes.
        if (!read && !authorizedParties.includes(req.headers.get('origin'))) {
          throw new ForbiddenError('untrusted request origin');
        }
        if (!auth.sessionId) return null;
        const session = await client.sessions.getSession(auth.sessionId);
        if (session.status !== 'active' || session.userId !== auth.userId) return null;
      }

      // No cached admission decision: banning/deleting a user closes access even for an existing API key/JWT.
      const user = await client.users.getUser(auth.userId);
      if (user.id !== auth.userId || user.banned || user.locked) return null;
      const primary = user.emailAddresses?.find((email) => email.id === user.primaryEmailAddressId);
      if (primary?.verification?.status !== 'verified') return null;
      return { kind: 'user', refId: `clerk:${user.id}`, via: `clerk-${auth.tokenType}` };
    } catch (e) {
      if (e instanceof ForbiddenError) throw e;
      if (e?.status === 404) return null;
      // Never log SDK error objects, which can contain request credentials or profile data.
      throw new Error('Clerk identity service unavailable');
    }
  };
}
