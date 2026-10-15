import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../../lib/identity.mjs';
import { ForbiddenError } from '../../lib/errors.mjs';

const resource = 'https://vault.test/mcp';
const issuer = 'https://clerk.vault.test';
const env = {
  MCP_RESOURCE_URL: resource, HEADJACK_AUTH_SERVER_URL: issuer,
  MCP_ALLOWED_ORIGINS: 'https://client.test,https://other.test', MCP_CURSOR_SECRET: 's' + 's'.repeat(31),
};
const config = { resource, issuer, allowedOrigins: ['https://client.test', 'https://other.test'], cursorSecret: env.MCP_CURSOR_SECRET };
const user = { id: 'user_A', banned: false, locked: false, primaryEmailAddressId: 'email_A', emailAddresses: [{ id: 'email_A', verification: { status: 'verified' } }] };
const grant = { userId: 'user_A', scopes: ['skills:read'], issuer, resource, active: true };
const providerGrant = { subject: 'user_A', scopes: ['skills:read'], aud: [resource], revoked: false, expired: false };
const request = (token = 'oat_' + 'fixture', options = {}) => new Request(resource, {
  method: 'POST', ...options, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
});
async function setup(overrides = {}, expectedToken = 'oat_' + 'fixture') {
  const { mcpOAuthResolver } = await import('../../lib/mcp/identity.mjs');
  const calls = { client: 0, grants: 0, users: 0, owners: 0 };
  const client = {
    users: { getUser: async (id) => { calls.users++; assert.equal(id, 'user_A'); return user; } },
    idPOAuthAccessToken: { verify: async (token, options) => {
      calls.grants++; assert.equal(token, expectedToken); assert.deepEqual(options, { audience: resource }); return providerGrant;
    } },
    ...overrides.client,
  };
  const resolve = mcpOAuthResolver({
    config, getClient: async () => { calls.client++; return client; },
    verifyGrant: async (input) => {
      calls.grants++; assert.deepEqual(input, { token: expectedToken, resource, issuer }); return grant;
    },
    ...overrides.resolver,
  });
  const identity = createIdentity({ resolvers: [resolve], resolveOwner: async (kind, refId) => {
    calls.owners++; assert.deepEqual([kind, refId], ['user', 'clerk:user_A']); return 7;
  } });
  return { resolve, identity, calls };
}

test('configuration uses canonical trusted URLs, exact origins and a dedicated secret', async () => {
  const { loadMcpConfig } = await import('../../lib/mcp/config.mjs');
  assert.deepEqual(loadMcpConfig(env), config);
  assert.deepEqual(loadMcpConfig({ ...env, MCP_ALLOWED_ORIGINS: ' https://client.test,https://client.test ' }).allowedOrigins, ['https://client.test']);
});

test('configuration rejects missing, noncanonical and unsafe resource or issuer URLs', async () => {
  const { loadMcpConfig } = await import('../../lib/mcp/config.mjs');
  for (const value of [undefined, '', 'http://vault.test/mcp', 'https://vault.test/', 'https://vault.test/mcp/', 'https://vault.test/mcp?q=x', 'https://vault.test/mcp#x', 'https://u:p' + '@vault.test/mcp', 'https://VAULT.test/mcp', 'https://vault.test:443/mcp', 'https://vault.test/x/../mcp']) {
    assert.throws(() => loadMcpConfig({ ...env, MCP_RESOURCE_URL: value }), /MCP_RESOURCE_URL/);
  }
  for (const value of [undefined, '', 'http://clerk.vault.test', 'https://u:p' + '@clerk.vault.test', 'https://clerk.vault.test/path', 'https://clerk.vault.test?q=x', 'https://clerk.vault.test#x']) {
    assert.throws(() => loadMcpConfig({ ...env, HEADJACK_AUTH_SERVER_URL: value }), /HEADJACK_AUTH_SERVER_URL/);
  }
});

test('mcp config reads HEADJACK_AUTH_SERVER_URL', async () => {
  const { loadMcpConfig } = await import('../../lib/mcp/config.mjs');
  assert.equal(loadMcpConfig(env).issuer, issuer);
  const { HEADJACK_AUTH_SERVER_URL: _issuer, ...withoutIssuer } = env;
  assert.throws(() => loadMcpConfig({ ...withoutIssuer, MCP_AUTH_SERVER_URL: issuer }), { message: /^HEADJACK_AUTH_SERVER_URL must/ });
});

test('configuration rejects missing or wildcard origins and short UTF-8 secrets', async () => {
  const { loadMcpConfig } = await import('../../lib/mcp/config.mjs');
  for (const value of [undefined, '', '*', 'https://client.test/path', 'https://client.test/', 'https://client.test,', 'http://client.test', 'https://u:p' + '@client.test']) {
    assert.throws(() => loadMcpConfig({ ...env, MCP_ALLOWED_ORIGINS: value }), /MCP_ALLOWED_ORIGINS/);
  }
  for (const value of [undefined, '', 's'.repeat(31), 'é'.repeat(15)]) {
    assert.throws(() => loadMcpConfig({ ...env, MCP_CURSOR_SECRET: value }), /MCP_CURSOR_SECRET/);
  }
  assert.equal(loadMcpConfig({ ...env, MCP_CURSOR_SECRET: 'é' + 'é'.repeat(15) }).cursorSecret, 'é'.repeat(16));
});

test('configuration permits explicit HTTP loopback URLs for local tests', async () => {
  const { loadMcpConfig } = await import('../../lib/mcp/config.mjs');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const origin = `http://${host}:3000`;
    const local = loadMcpConfig({ ...env, MCP_RESOURCE_URL: `${origin}/mcp`, HEADJACK_AUTH_SERVER_URL: origin, MCP_ALLOWED_ORIGINS: origin });
    assert.equal(local.resource, `${origin}/mcp`);
    assert.deepEqual(local.allowedOrigins, [origin]);
  }
});

test('OAuth read grant authorizes POST and maps only the immutable live user', async () => {
  const { identity, calls } = await setup();
  const who = await identity.identify(request('oat_fixture', { headers: { 'x-owner-id': '99', 'x-user-id': 'user_B', origin: 'https://evil.test' } }));
  assert.deepEqual(who, { ownerId: 7, subject: { kind: 'user', refId: 'clerk:user_A', via: 'clerk-mcp-oauth' } });
  assert.equal(calls.grants, 1); assert.equal(calls.users, 1); assert.equal(calls.owners, 1);
});

for (const [scheme, spaces] of [['Bearer', 1], ['bearer', 1], ['BEARER', 1], ['bEaReR', 1], ['Bearer', 2], ['bearer', 3]]) {
  test(`Bearer syntax accepts ${scheme} with ${spaces} SP and preserves token value on every request`, async () => {
    const token = 'oat_' + 'MiXeD9_-';
    for (const defaultAdapter of [false, true]) {
      const { identity, calls } = await setup({ resolver: defaultAdapter ? { verifyGrant: undefined } : {} }, token);
      const req = request(null, { headers: { authorization: `${scheme}${' '.repeat(spaces)}${token}` } });
      assert.equal((await identity.identify(req))?.ownerId, 7);
      assert.equal((await identity.identify(req))?.ownerId, 7);
      assert.deepEqual(calls, { client: 2, grants: 2, users: 2, owners: 1 });
    }
  });
}

test('anonymous, session, API-key, M2M and legacy credentials never contact the provider or owner', async () => {
  const { identity, calls } = await setup();
  for (const token of [null, 'eyJhbGciOi.session.signature', 'sk_fixture', 'ak_fixture', 'm2m_fixture', 'legacy-token', 'oat_']) {
    assert.equal(await identity.identify(request(token)), null);
  }
  for (const authorization of [
    'Basic oat_fixture', 'Beareroat_fixture', 'Bearer oat_fixture extra',
    'Bearer\toat_fixture', 'Bearer \toat_fixture', 'Bearer\t oat_fixture',
    'Bearer oat_fix ture', 'Bearer oat_fix\tture', 'Bearer OAT_fixture', 'bearer oaT_fixture',
    'Bearer oat_fixture=', 'Bearer oat_fixture/', 'Bearer oat_fixture,',
  ]) {
    assert.equal(await identity.identify(request(null, { headers: { authorization } })), null);
  }
  assert.deepEqual(calls, { client: 0, grants: 0, users: 0, owners: 0 });
});

test('missing or mismatched issuer and resource, incomplete or inactive grants fail before admission', async () => {
  const invalid = [null, { ...grant, issuer: 'https://evil.test' }, { ...grant, resource: 'https://evil.test/mcp' }, { ...grant, active: false }, { ...grant, active: 'true' }, { ...grant, userId: 'org_A' }];
  for (const field of Object.keys(grant)) { const incomplete = { ...grant }; delete incomplete[field]; invalid.push(incomplete); }
  for (const changed of invalid) {
    const { identity, calls } = await setup({ resolver: { verifyGrant: async () => changed } });
    assert.equal(await identity.identify(request()), null);
    assert.equal(calls.users, 0); assert.equal(calls.owners, 0);
  }
});

test('insufficient skills:read scope throws ForbiddenError even for POST reads and never resolves owner', async () => {
  for (const scopes of [[], ['openid'], ['skills:write']]) {
    const { identity, calls } = await setup({ resolver: { verifyGrant: async () => ({ ...grant, scopes }) } });
    await assert.rejects(identity.identify(request()), ForbiddenError);
    assert.equal(calls.users, 0); assert.equal(calls.owners, 0);
  }
  const { resolve } = await setup({ resolver: { verifyGrant: async () => ({ ...grant, scopes: 'skills:read' }) } });
  assert.equal(await resolve(request()), null);
});

test('unverified, missing-primary, mismatched, banned and locked users never resolve owner', async () => {
  for (const changed of [{ ...user, banned: true }, { ...user, locked: true }, { ...user, id: 'user_B' }, { ...user, primaryEmailAddressId: null }, { ...user, emailAddresses: [] }, { ...user, emailAddresses: [{ id: 'email_A', verification: { status: 'unverified' } }] }]) {
    const { identity, calls } = await setup({ client: { users: { getUser: async () => changed } } });
    assert.equal(await identity.identify(request()), null); assert.equal(calls.owners, 0);
  }
});

test('deleted user returns null while user service failure is sanitized unavailable', async () => {
  for (const status of [401, 404, 503]) {
    const { identity, calls } = await setup({ client: { users: { getUser: async () => { throw Object.assign(Error('sensitive profile and credential'), { status }); } } } });
    if (status === 404) assert.equal(await identity.identify(request()), null);
    else await assert.rejects(identity.identify(request()), (e) => e.message === 'MCP identity service unavailable' && !e.cause);
    assert.equal(calls.owners, 0);
  }
});

for (const status of [401, 404, 503]) {
  test(`client initialization ${status} is sanitized unavailable before verification, admission or owner lookup`, async () => {
    for (const defaultAdapter of [false, true]) {
      let acquisitions = 0;
      const resolver = { getClient: async () => {
        acquisitions++;
        throw Object.assign(Error('sensitive SDK credentials'), { status, cause: Error('private client configuration') });
      } };
      if (defaultAdapter) resolver.verifyGrant = undefined;
      const { resolve, identity, calls } = await setup({ resolver });
      const sanitized = (error) => error instanceof Error
        && error.message === 'MCP identity service unavailable' && error.cause === undefined;
      await assert.rejects(resolve(request()), sanitized);
      await assert.rejects(identity.identify(request()), sanitized);
      assert.equal(acquisitions, 2);
      assert.deepEqual(calls, { client: 0, grants: 0, users: 0, owners: 0 });
    }
  });
}

test('grant 401/404 and audience verification failures deny; provider outage is sanitized unavailable', async () => {
  for (const error of [Object.assign(Error('invalid token'), { status: 401 }), Object.assign(Error('revoked'), { status: 404 }), Object.assign(Error('audience details'), { reason: 'token-verification-failed' })]) {
    const { identity, calls } = await setup({ resolver: { verifyGrant: async () => { throw error; } } });
    assert.equal(await identity.identify(request()), null); assert.equal(calls.users, 0); assert.equal(calls.owners, 0);
  }
  const { resolve } = await setup({ resolver: { verifyGrant: async () => { throw Object.assign(Error('sensitive SDK credentials'), { status: 503 }); } } });
  const providerDown = request();
  await assert.rejects(resolve(providerDown), /unavailable/);
  await assert.rejects(resolve(providerDown), (e) => e.message === 'MCP identity service unavailable' && !e.cause);
});

test('next request after revocation fails even with cached owner mapping', async () => {
  let active = true; let verifications = 0;
  const { identity, resolve, calls } = await setup({ resolver: { verifyGrant: async () => { verifications++; return { ...grant, active }; } } });
  assert.equal((await identity.identify(request())).ownerId, 7);
  assert.equal((await identity.identify(request())).ownerId, 7);
  assert.equal(calls.owners, 1); assert.equal(calls.users, 2);
  active = false;
  const reqWithRevokedGrant = request();
  assert.equal(await resolve(reqWithRevokedGrant), null);
  assert.equal(await identity.identify(reqWithRevokedGrant), null);
  assert.equal(verifications, 4); assert.equal(calls.users, 2); assert.equal(calls.owners, 1);
});

test('live user admission is repeated even when the owner mapping is cached', async () => {
  let current = user; let admissions = 0;
  const { identity, calls } = await setup({ client: { users: { getUser: async () => { admissions++; return current; } } } });
  assert.equal((await identity.identify(request())).ownerId, 7);
  current = { ...user, banned: true };
  assert.equal(await identity.identify(request()), null);
  assert.equal(admissions, 2); assert.equal(calls.grants, 2); assert.equal(calls.owners, 1);
});

test('default adapter verifies OAuth online with canonical audience on every request', async () => {
  const { identity, calls } = await setup({ resolver: { verifyGrant: undefined } });
  assert.equal((await identity.identify(request())).subject.via, 'clerk-mcp-oauth');
  assert.equal((await identity.identify(request())).ownerId, 7);
  assert.equal(calls.client, 2); assert.equal(calls.grants, 2); assert.equal(calls.users, 2); assert.equal(calls.owners, 1);
});

test('default adapter rejects missing audience, scopes, subject or inactive provider flags', async () => {
  const invalid = [null, { ...providerGrant, aud: [] }, { ...providerGrant, aud: ['https://evil.test/mcp'] }, { ...providerGrant, revoked: true }, { ...providerGrant, expired: true }, { ...providerGrant, subject: 'org_A' }];
  for (const field of Object.keys(providerGrant)) { const incomplete = { ...providerGrant }; delete incomplete[field]; invalid.push(incomplete); }
  for (const changed of invalid) {
    const { identity, calls } = await setup({ resolver: { verifyGrant: undefined }, client: { idPOAuthAccessToken: { verify: async () => changed } } });
    assert.equal(await identity.identify(request()), null); assert.equal(calls.users, 0); assert.equal(calls.owners, 0);
  }
});

test('default adapter provider errors fail closed without falling back to other Clerk authentication', async () => {
  for (const status of [401, 404, 503]) {
    const { resolve, calls } = await setup({ resolver: { verifyGrant: undefined }, client: {
      authenticateRequest: () => { throw Error('must not fall back'); },
      idPOAuthAccessToken: { verify: async () => { throw Object.assign(Error('sensitive SDK response'), { status }); } },
    } });
    if (status === 503) await assert.rejects(resolve(request()), /unavailable/);
    else assert.equal(await resolve(request()), null);
    assert.equal(calls.users, 0); assert.equal(calls.owners, 0);
  }
});
