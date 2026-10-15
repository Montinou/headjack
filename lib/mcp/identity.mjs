import { ForbiddenError } from '../errors.mjs';
import { OAT_BEARER as OAUTH_BEARER, admitClerkUser, verifyResourceGrant } from '../oauth-grant.mjs';

const USER_ID = /^user_[A-Za-z0-9]+$/;

// getClient must be a server-owned official Clerk client configured with the key for config.issuer.
// T1 proved this provider/key path: opaque OAuth responses have no issuer field. Only after online
// verification through that trusted client do we normalize the configured issuer into the grant.
async function verifyProviderGrant(client, { token, resource, issuer }) {
  const verified = await verifyResourceGrant(client, { token, resource });
  return verified && { ...verified, issuer, resource, active: true };
}

export function mcpOAuthResolver({ getClient, verifyGrant, config }) {
  return async (req) => {
    const token = OAUTH_BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return null;
    const input = { token, resource: config.resource, issuer: config.issuer };
    let client;
    let grant;
    try {
      client = await getClient();
    } catch {
      throw new Error('MCP identity service unavailable');
    }
    try {
      grant = await (verifyGrant ? verifyGrant(input) : verifyProviderGrant(client, input));
    } catch (e) {
      if (e?.status === 401 || e?.status === 404 || e?.reason === 'token-verification-failed') return null;
      throw new Error('MCP identity service unavailable');
    }
    if (!grant || grant.active !== true || !USER_ID.test(grant.userId ?? '')
      || grant.issuer !== config.issuer || grant.resource !== config.resource
      || !Array.isArray(grant.scopes) || !grant.scopes.every((scope) => typeof scope === 'string')) return null;
    // POST carries read-only MCP operations, so REST's method-derived scope policy does not apply.
    if (!grant.scopes.includes('skills:read')) throw new ForbiddenError('missing required skill scope');

    let refId;
    try {
      // Neither grant verification nor user admission is cached; createIdentity only caches owner mapping.
      refId = await admitClerkUser(client, grant.userId);
    } catch {
      // admitClerkUser already dropped every SDK detail; keep the MCP-specific message.
      throw new Error('MCP identity service unavailable');
    }
    return refId ? { kind: 'user', refId, via: 'clerk-mcp-oauth' } : null;
  };
}
