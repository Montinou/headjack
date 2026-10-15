import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as clerk from '../../lib/clerk-identity.mjs';
import { createHandlers } from '../../lib/handlers.mjs';

const origin = 'https://vault.test';
const env = { CLERK_AUTHORIZED_PARTIES: origin };
const user = { id: 'user_A', banned: false, locked: false, primaryEmailAddressId: 'email_A', emailAddresses: [{ id: 'email_A', verification: { status: 'verified' } }] };
const session = { id: 'sess_A', userId: 'user_A', status: 'active' };
const request = (options = {}) => new Request(`${origin}/api/skills/x`, options);
function setup(auth = { tokenType: 'session_token', userId: 'user_A', sessionId: 'sess_A' }, overrides = {}) {
  const client = {
    authenticateRequest: async (_req, options) => {
      assert.deepEqual(options.authorizedParties, [origin]);
      assert.deepEqual(options.acceptsToken, ['session_token', 'api_key']);
      return { isAuthenticated: true, toAuth: () => auth };
    },
    users: { getUser: async () => user },
    sessions: { getSession: async () => session },
    ...overrides,
  };
  return clerk.clerkIdentityResolver({ getClient: async () => client, enabled: async () => true, env });
}

test('verified Clerk session maps immutable user ID, never an organization or caller owner header', async () => {
  assert.equal(typeof clerk.clerkIdentityResolver, 'function');
  const result = await setup()(request({ headers: { 'x-owner-id': '1' } }));
  assert.deepEqual(result, { kind: 'user', refId: 'clerk:user_A', via: 'clerk-session_token' });
});

test('disabled rollout never contacts Clerk or authorizes a user', async () => {
  const resolve = clerk.clerkIdentityResolver({ getClient: () => { throw Error('must not load'); }, enabled: async () => false, env });
  assert.equal(await resolve(request()), null);
});

test('anonymous, forged, organization and machine identities cannot create an owner', async () => {
  const anonymous = setup({}, { authenticateRequest: async () => ({ isAuthenticated: false }) });
  assert.equal(await anonymous(request()), null);
  for (const auth of [
    { tokenType: 'api_key', userId: null, subject: 'org_A', scopes: ['skills:read'] },
    { tokenType: 'm2m_token', userId: 'user_A', scopes: ['skills:read'] },
    { tokenType: 'oauth_token', userId: 'user_A', scopes: ['skills:read'] },
    { tokenType: 'session_token', userId: 'legacy:v1' },
  ]) assert.equal(await setup(auth)(request()), null);
});

test('user API keys share the session owner but need the specific operation scope', async () => {
  for (const tokenType of ['api_key']) {
    const resolve = setup({ tokenType, userId: 'user_A', scopes: ['skills:read'] });
    assert.equal((await resolve(request())).refId, 'clerk:user_A');
    await assert.rejects(resolve(request({ method: 'POST' })), { name: 'ForbiddenError' });
    await assert.rejects(setup({ tokenType, userId: 'user_A', scopes: ['openid'] })(request()), { name: 'ForbiddenError' });
    assert.equal((await setup({ tokenType, userId: 'user_A', scopes: ['skills:write'] })(request({ method: 'POST' }))).refId, 'clerk:user_A');
  }
});

test('banned, locked, deleted and mismatched users fail closed on every request', async () => {
  for (const changed of [{ ...user, banned: true }, { ...user, locked: true }, { ...user, id: 'user_B' }]) {
    assert.equal(await setup(undefined, { users: { getUser: async () => changed } })(request()), null);
  }
  const resolve = setup(undefined, { users: { getUser: async () => { throw Object.assign(Error('deleted'), { status: 404 }); } } });
  assert.equal(await resolve(request()), null);
  const down = setup(undefined, { users: { getUser: async () => { throw Object.assign(Error('sensitive SDK details'), { status: 503 }); } } });
  await assert.rejects(down(request()), (e) => e.message === 'Clerk identity service unavailable' && !e.cause);
});

test('revoked or mismatched sessions cannot keep access until JWT expiry', async () => {
  for (const changed of [{ ...session, status: 'revoked' }, { ...session, userId: 'user_B' }]) {
    assert.equal(await setup(undefined, { sessions: { getSession: async () => changed } })(request()), null);
  }
});

test('reserved initial accounts must verify their primary email before accessing skills', async () => {
  const unverified = { ...user, emailAddresses: [{ id: 'email_A', verification: { status: 'unverified' } }] };
  assert.equal(await setup(undefined, { users: { getUser: async () => unverified } })(request()), null);
});

test('cookie mutations require a trusted Origin, while scoped bearer clients do not need Origin', async () => {
  for (const originHeader of [undefined, 'https://evil.test']) {
    await assert.rejects(setup()(request({ method: 'POST', headers: originHeader ? { origin: originHeader } : {} })), { name: 'ForbiddenError' });
  }
  assert.ok(await setup()(request({ method: 'POST', headers: { origin } })));
});

test('missing or malformed authorized parties cannot silently disable origin verification', async () => {
  for (const value of ['', '*', 'https://vault.test/path', 'https://vault.test,https://evil.test/path']) {
    const resolve = clerk.clerkIdentityResolver({ getClient: () => { throw Error('must validate first'); }, enabled: async () => true, env: { CLERK_AUTHORIZED_PARTIES: value } });
    await assert.rejects(resolve(request()), /CLERK_AUTHORIZED_PARTIES/);
  }
});

// REST OAuth access tokens (opaque `oat_`) skip authenticateRequest and are verified once against the API resource.
const apiResource = 'https://vault.test/api';
const oauthEnv = { ...env, HEADJACK_API_RESOURCE_URL: apiResource, HEADJACK_AUTH_SERVER_URL: 'https://clerk.vault.test' };
const apiGrant = { subject: 'user_A', scopes: ['skills:read'], aud: [apiResource], revoked: false, expired: false };
const oat = 'oat_' + 'fixture';
const bearer = (value, options = {}) => request({ ...options, headers: { authorization: `Bearer ${value}`, ...options.headers } });
function oauthSetup({ grant = apiGrant, verify, resolverEnv = oauthEnv } = {}) {
  const calls = { authenticate: 0, verify: 0, users: 0 };
  const client = {
    authenticateRequest: async (req, options) => {
      calls.authenticate++;
      assert.deepEqual(options.acceptsToken, ['session_token', 'api_key']);
      // The SDK reports a bearer of a type outside acceptsToken (here: a JWT-format OAuth token) as unauthenticated.
      if (!/^Bearer ak_/.test(req.headers.get('authorization') ?? '')) return { isAuthenticated: false };
      return { isAuthenticated: true, toAuth: () => ({ tokenType: 'api_key', userId: 'user_A', scopes: ['skills:read'] }) };
    },
    idPOAuthAccessToken: { verify: async (value, options) => {
      calls.verify++;
      assert.equal(value, oat);
      assert.deepEqual(options, { audience: apiResource });
      return verify ? verify() : grant;
    } },
    users: { getUser: async (id) => { calls.users++; assert.equal(id, 'user_A'); return user; } },
    sessions: { getSession: async () => session },
  };
  const resolve = clerk.clerkIdentityResolver({ getClient: async () => client, enabled: async () => true, env: resolverEnv });
  return { resolve, calls };
}

test('oat_ with the api audience is admitted with skills:read on GET', async () => {
  const { resolve, calls } = oauthSetup();
  const who = await resolve(bearer(oat));
  assert.deepEqual(who, { kind: 'user', refId: 'clerk:user_A', via: 'clerk-oauth_token' });
  assert.equal(who.refId, 'clerk:user_A');
  assert.equal(who.via, 'clerk-oauth_token');
  assert.deepEqual(calls, { authenticate: 0, verify: 1, users: 1 });
});

test('oat_ with the mcp audience is rejected on REST', async () => {
  for (const aud of [['https://x/mcp'], ['https://vault.test/mcp'], [], undefined]) {
    const { resolve, calls } = oauthSetup({ grant: { ...apiGrant, aud } });
    assert.equal(await resolve(bearer(oat)), null);
    assert.deepEqual(calls, { authenticate: 0, verify: 1, users: 0 });
  }
});

test('oat_ missing skills:write on POST is 403', async () => {
  const { resolve, calls } = oauthSetup();
  await assert.rejects(resolve(bearer(oat, { method: 'POST' })), { name: 'ForbiddenError' });
  assert.equal(calls.users, 0);
  await assert.rejects(oauthSetup({ grant: { ...apiGrant, scopes: ['skills:write'] } }).resolve(bearer(oat)), { name: 'ForbiddenError' });
  const writer = oauthSetup({ grant: { ...apiGrant, scopes: ['skills:read', 'skills:write'] } });
  assert.equal((await writer.resolve(bearer(oat, { method: 'POST' }))).refId, 'clerk:user_A');
});

test('revoked or expired oat_ is null', async () => {
  const invalid = [{ ...apiGrant, revoked: true }, { ...apiGrant, expired: true }, { ...apiGrant, revoked: undefined },
    { ...apiGrant, subject: 'org_A' }, { ...apiGrant, scopes: 'skills:read' }, { ...apiGrant, scopes: [7] }, null];
  for (const grant of invalid) {
    const { resolve, calls } = oauthSetup({ grant });
    assert.equal(await resolve(bearer(oat)), null);
    assert.equal(calls.users, 0);
  }
  for (const error of [{ status: 401 }, { status: 404 }, { reason: 'token-verification-failed' }]) {
    const { resolve, calls } = oauthSetup({ verify: () => { throw Object.assign(Error('sdk detail'), error); } });
    assert.equal(await resolve(bearer(oat)), null);
    assert.equal(calls.users, 0);
  }
});

test('oat_ with no api oauth configuration is null', async () => {
  const { HEADJACK_API_RESOURCE_URL: _resource, ...withoutResource } = oauthEnv;
  const { HEADJACK_AUTH_SERVER_URL: _issuer, ...withoutIssuer } = oauthEnv;
  for (const resolverEnv of [env, withoutResource, withoutIssuer, { ...oauthEnv, HEADJACK_API_RESOURCE_URL: 'http://evil.example/api' }]) {
    const { resolve, calls } = oauthSetup({ resolverEnv });
    assert.equal(await resolve(bearer(oat)), null);
    assert.deepEqual(calls, { authenticate: 0, verify: 0, users: 0 });
  }
});

test('provider outage on oat_ is 500 and api keys unaffected', async () => {
  const { resolve, calls } = oauthSetup({ verify: () => { throw Object.assign(Error('sensitive SDK response'), { status: 503 }); } });
  await assert.rejects(resolve(bearer(oat)), (e) => /identity service unavailable/.test(e.message) && !e.cause);
  assert.equal(calls.users, 0);

  const h = createHandlers({ identify: resolve, repoFor: () => { throw Error('must not reach a repo'); }, listOwnerIds: async () => [], embed: async () => [], env: {} });
  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await h.search(bearer(oat));
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /sensitive/);
  } finally {
    console.error = origErr;
  }

  const apiKey = await resolve(bearer('ak_' + 'fixture'));
  assert.deepEqual(apiKey, { kind: 'user', refId: 'clerk:user_A', via: 'clerk-api_key' });
  assert.equal(calls.authenticate, 1);
});

test('at+jwt bearer gets null', async () => {
  const { resolve, calls } = oauthSetup();
  assert.equal(await resolve(bearer('eyJhbGciOi.at-jwt.signature')), null);
  assert.deepEqual(calls, { authenticate: 1, verify: 0, users: 0 });
});

test('preview adds vercel origins', () => {
  const preview = { VERCEL_ENV: 'preview', VERCEL_URL: 'a.vercel.app', VERCEL_BRANCH_URL: 'b.vercel.app', CLERK_AUTHORIZED_PARTIES: '' };
  assert.deepEqual(clerk.clerkAuthorizedParties(preview), ['https://a.vercel.app', 'https://b.vercel.app']);
  assert.deepEqual(clerk.clerkAuthorizedParties({ ...preview, CLERK_AUTHORIZED_PARTIES: origin }), [origin, 'https://a.vercel.app', 'https://b.vercel.app']);
  assert.deepEqual(clerk.clerkAuthorizedParties({ ...preview, VERCEL_BRANCH_URL: undefined }), ['https://a.vercel.app']);
  assert.throws(() => clerk.clerkAuthorizedParties({ VERCEL_ENV: 'preview', CLERK_AUTHORIZED_PARTIES: '' }), /CLERK_AUTHORIZED_PARTIES/);
  assert.throws(() => clerk.clerkAuthorizedParties({ ...preview, VERCEL_URL: 'a.vercel.app/path' }), /CLERK_AUTHORIZED_PARTIES/);
  for (const VERCEL_ENV of ['production', 'development', undefined]) {
    assert.throws(() => clerk.clerkAuthorizedParties({ ...preview, VERCEL_ENV }), /CLERK_AUTHORIZED_PARTIES/);
    assert.deepEqual(clerk.clerkAuthorizedParties({ ...preview, VERCEL_ENV, CLERK_AUTHORIZED_PARTIES: origin }), [origin]);
  }
});
