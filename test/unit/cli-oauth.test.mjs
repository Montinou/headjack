import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  discoverApi, authServerMetadata, pkcePair, exchangeCode, refreshTokens, revokeToken, fetchEmail,
} from '../../cli/oauth.mjs';
import { UserError } from '../../lib/errors.mjs';

const HEADJACK = 'https://headjack.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const EXTRA = 'x-extra-header';
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;

// A fetch fake: routes maps a URL to a Response factory (or a function of the request); every request is recorded.
function fakeFetch(routes) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
    requests.push({ url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body });
    const route = routes[String(url)];
    if (!route) return new Response('not found', { status: 404 });
    return typeof route === 'function' ? route(init) : route.clone();
  };
  return { fetchImpl, requests };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const protectedResource = (over = {}) => ({
  resource: `${HEADJACK}/api`,
  authorization_servers: [ISSUER],
  scopes_supported: ['skills:read', 'skills:write'],
  bearer_methods_supported: ['header'],
  headjack_cli_client_id: 'client_cli',
  ...over,
});
const oauthDoc = (over = {}) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: TOKEN_ENDPOINT,
  revocation_endpoint: `${ISSUER}/oauth/token/revoke`,
  code_challenge_methods_supported: ['S256'],
  ...over,
});
const openidDoc = (over = {}) => ({ issuer: ISSUER, userinfo_endpoint: `${ISSUER}/oauth/userinfo`, ...over });
const wellKnown = (name) => `${ISSUER}/.well-known/${name}`;
const issuerRoutes = (oauth = oauthDoc(), openid = openidDoc()) => ({
  [wellKnown('oauth-authorization-server')]: json(oauth),
  [wellKnown('openid-configuration')]: json(openid),
});

test('discoverApi reads the protected-resource document and sends only the given headers', async () => {
  const { fetchImpl, requests } = fakeFetch({ [`${HEADJACK}/.well-known/oauth-protected-resource/api`]: json(protectedResource()) });
  const found = await discoverApi(HEADJACK, { fetchImpl, headers: { [EXTRA]: 'extra-value' } });
  assert.deepEqual(found, { resource: `${HEADJACK}/api`, issuer: ISSUER, clientId: 'client_cli' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers[EXTRA], 'extra-value');
});

test('discoverApi sends no extra headers when none are given', async () => {
  const { fetchImpl, requests } = fakeFetch({ [`${HEADJACK}/.well-known/oauth-protected-resource/api`]: json(protectedResource()) });
  await discoverApi(HEADJACK, { fetchImpl });
  assert.equal(requests[0].headers[EXTRA], undefined);
});

test('discovery compares canonical forms: case, default port and trailing slash do not matter', async () => {
  const url = `${HEADJACK}/.well-known/oauth-protected-resource/api`;
  for (const [given, resource] of [
    ['HTTPS://HEADJACK.example.invalid', `${HEADJACK}/api`],
    ['https://headjack.example.invalid:443/', `${HEADJACK}/api`],
    [HEADJACK, 'https://Headjack.Example.invalid:443/api'],
    [HEADJACK, `${HEADJACK}/api/`],
  ]) {
    const { fetchImpl, requests } = fakeFetch({ [url]: json(protectedResource({ resource })) });
    const found = await discoverApi(given, { fetchImpl });
    assert.equal(requests[0].url, url, given);
    assert.equal(found.resource, resource, given);
  }
});

test('discovery 404 says this server has not enabled CLI login', async () => {
  const { fetchImpl } = fakeFetch({});
  await assert.rejects(discoverApi(HEADJACK, { fetchImpl }), (e) => e instanceof UserError && e.message === 'this server has not enabled CLI login');
});

test('discovery resource mismatch is refused', async () => {
  const { fetchImpl } = fakeFetch({ [`${HEADJACK}/.well-known/oauth-protected-resource/api`]: json(protectedResource({ resource: 'https://other.example.invalid/api' })) });
  await assert.rejects(
    discoverApi(HEADJACK, { fetchImpl }),
    (e) => e instanceof UserError && !e.message.includes('\n') && e.message.includes(`${HEADJACK}/.well-known/oauth-protected-resource/api`) && /resource/.test(e.message),
  );
});

test('discovery refuses a missing client id and anything but exactly one authorization server', async () => {
  for (const over of [
    { headjack_cli_client_id: '' },
    { headjack_cli_client_id: undefined },
    { authorization_servers: [] },
    { authorization_servers: [ISSUER, 'https://second.example.invalid'] },
    { authorization_servers: 'nope' },
  ]) {
    const { fetchImpl } = fakeFetch({ [`${HEADJACK}/.well-known/oauth-protected-resource/api`]: json(protectedResource(over)) });
    await assert.rejects(discoverApi(HEADJACK, { fetchImpl }), UserError, JSON.stringify(over));
  }
});

test('discovery failures are one-line UserErrors naming the URL', async () => {
  const url = `${HEADJACK}/.well-known/oauth-protected-resource/api`;
  const cases = {
    network: async () => { throw new TypeError('fetch failed'); },
    http500: async () => new Response('boom', { status: 500 }),
    notJson: async () => new Response('<html>', { status: 200 }),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    await assert.rejects(
      discoverApi(HEADJACK, { fetchImpl }),
      (e) => e instanceof UserError && !e.message.includes('\n') && e.message.includes(url),
      name,
    );
  }
});

test('authServerMetadata merges both documents and takes userinfo from the OpenID one', async () => {
  const { fetchImpl, requests } = fakeFetch(issuerRoutes());
  const meta = await authServerMetadata(ISSUER, { fetchImpl });
  assert.deepEqual(meta, {
    authorizationEndpoint: `${ISSUER}/oauth/authorize`,
    tokenEndpoint: TOKEN_ENDPOINT,
    revocationEndpoint: `${ISSUER}/oauth/token/revoke`,
    userinfoEndpoint: `${ISSUER}/oauth/userinfo`,
  });
  assert.deepEqual(requests.map((r) => r.url).sort(), [wellKnown('oauth-authorization-server'), wellKnown('openid-configuration')]);
});

test('issuer mismatch between the documents is refused', async () => {
  for (const [oauth, openid] of [
    [oauthDoc(), openidDoc({ issuer: 'https://evil.example.invalid' })],
    [oauthDoc({ issuer: 'https://evil.example.invalid' }), openidDoc()],
  ]) {
    const { fetchImpl } = fakeFetch(issuerRoutes(oauth, openid));
    await assert.rejects(authServerMetadata(ISSUER, { fetchImpl }), (e) => e instanceof UserError && !e.message.includes('\n') && /issuer/.test(e.message));
  }
});

test('an authorization server without S256 is refused', async () => {
  for (const methods of [['plain'], undefined, []]) {
    const { fetchImpl } = fakeFetch(issuerRoutes(oauthDoc({ code_challenge_methods_supported: methods })));
    await assert.rejects(authServerMetadata(ISSUER, { fetchImpl }), (e) => e instanceof UserError && /S256/.test(e.message));
  }
});

test('authServerMetadata refuses missing endpoints and unreachable documents', async () => {
  for (const [field, oauth, openid, docUrl] of [
    ['token_endpoint', oauthDoc({ token_endpoint: undefined }), openidDoc(), wellKnown('oauth-authorization-server')],
    ['authorization_endpoint', oauthDoc({ authorization_endpoint: undefined }), openidDoc(), wellKnown('oauth-authorization-server')],
    ['revocation_endpoint', oauthDoc({ revocation_endpoint: undefined }), openidDoc(), wellKnown('oauth-authorization-server')],
    ['userinfo_endpoint', oauthDoc(), openidDoc({ userinfo_endpoint: undefined }), wellKnown('openid-configuration')],
  ]) {
    const { fetchImpl } = fakeFetch(issuerRoutes(oauth, openid));
    await assert.rejects(
      authServerMetadata(ISSUER, { fetchImpl }),
      (e) => e instanceof UserError && !e.message.includes('\n') && e.message.includes(docUrl) && e.message.includes(field),
      field,
    );
  }
  const { fetchImpl } = fakeFetch({});
  await assert.rejects(authServerMetadata(ISSUER, { fetchImpl }), (e) => e instanceof UserError && e.message.includes(wellKnown('oauth-authorization-server')));
});

test('authServerMetadata refuses an insecure endpoint but accepts http on loopback', async () => {
  const { fetchImpl } = fakeFetch(issuerRoutes(oauthDoc({ token_endpoint: 'http://auth.example.invalid/oauth/token' })));
  await assert.rejects(authServerMetadata(ISSUER, { fetchImpl }), (e) => e instanceof UserError && /token_endpoint/.test(e.message));

  const loopback = 'http://127.0.0.1:4010';
  const routes = {
    [`${loopback}/.well-known/oauth-authorization-server`]: json({
      issuer: loopback,
      authorization_endpoint: `${loopback}/authorize`,
      token_endpoint: `${loopback}/token`,
      revocation_endpoint: `${loopback}/revoke`,
      code_challenge_methods_supported: ['S256'],
    }),
    [`${loopback}/.well-known/openid-configuration`]: json({ issuer: loopback, userinfo_endpoint: `${loopback}/userinfo` }),
  };
  const meta = await authServerMetadata(loopback, { fetchImpl: fakeFetch(routes).fetchImpl });
  assert.equal(meta.tokenEndpoint, `${loopback}/token`);

  const evilEndpoint = fakeFetch({
    [`${loopback}/.well-known/oauth-authorization-server`]: json({
      issuer: loopback,
      authorization_endpoint: `${loopback}/authorize`,
      token_endpoint: 'http://evil.example/token',
      revocation_endpoint: `${loopback}/revoke`,
      code_challenge_methods_supported: ['S256'],
    }),
    [`${loopback}/.well-known/openid-configuration`]: json({ issuer: loopback, userinfo_endpoint: `${loopback}/userinfo` }),
  });
  await assert.rejects(authServerMetadata(loopback, { fetchImpl: evilEndpoint.fetchImpl }), (e) => e instanceof UserError && /token_endpoint/.test(e.message));
});

test('authServerMetadata refuses an http issuer that is not loopback before any request', async () => {
  const { fetchImpl, requests } = fakeFetch({});
  await assert.rejects(
    authServerMetadata('http://evil.example', { fetchImpl }),
    (e) => e instanceof UserError && !e.message.includes('\n') && e.message.includes('http://evil.example'),
  );
  assert.equal(requests.length, 0);
});

// A real loopback server: [status, location | undefined, requests it saw].
function listen(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

test('discovery refuses a redirect and the target never receives the extra header', async () => {
  const target = await listen((_req, res) => { res.end('{}'); });
  const source = await listen((_req, res) => { res.writeHead(302, { location: `${target.origin}/elsewhere` }); res.end(); });
  try {
    await assert.rejects(
      discoverApi(source.origin, { headers: { [EXTRA]: 'extra-value' } }),
      (e) => e instanceof UserError && !e.message.includes('\n') && e.message.includes(`${source.origin}/.well-known/oauth-protected-resource/api`),
    );
    assert.equal(source.seen.length, 1);
    assert.equal(target.seen.length, 0);
  } finally {
    await close(source.server);
    await close(target.server);
  }
});

test('discovery refuses a redirect status from the transport', async () => {
  const { fetchImpl } = fakeFetch({ [`${HEADJACK}/.well-known/oauth-protected-resource/api`]: new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.invalid/' } }) });
  await assert.rejects(discoverApi(HEADJACK, { fetchImpl }), (e) => e instanceof UserError && /redirect/.test(e.message));
});

test('token and revocation POSTs refuse a redirecting authorization server', async () => {
  const target = await listen((_req, res) => { res.end('{}'); });
  const source = await listen((_req, res) => { res.writeHead(307, { location: `${target.origin}/token` }); res.end(); });
  try {
    await assert.rejects(
      exchangeCode({ tokenEndpoint: `${source.origin}/token`, clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', resource: 'r' }),
      (e) => e instanceof UserError && e.message.includes(`${source.origin}/token`),
    );
    assert.equal(await revokeToken({ revocationEndpoint: `${source.origin}/revoke`, clientId: 'c', token: 't', hint: 'refresh_token' }), false);
    assert.equal(target.seen.length, 0);
  } finally {
    await close(source.server);
    await close(target.server);
  }
});

test('no request to the issuer carries the extra header', async () => {
  const { fetchImpl, requests } = fakeFetch({
    [`${HEADJACK}/.well-known/oauth-protected-resource/api`]: json(protectedResource()),
    ...issuerRoutes(),
    [TOKEN_ENDPOINT]: json({ access_token: 'a', refresh_token: 'r', expires_in: 60 }),
    [`${ISSUER}/oauth/token/revoke`]: new Response(null, { status: 200 }),
    [`${ISSUER}/oauth/userinfo`]: json({ email: 'a@example.invalid' }),
  });
  const { issuer, clientId, resource } = await discoverApi(HEADJACK, { fetchImpl, headers: { [EXTRA]: 'extra-value' } });
  const meta = await authServerMetadata(issuer, { fetchImpl });
  await exchangeCode({ tokenEndpoint: meta.tokenEndpoint, clientId, code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:53437/callback', resource }, { fetchImpl });
  await refreshTokens({ tokenEndpoint: meta.tokenEndpoint, clientId, refreshToken: 'r', resource }, { fetchImpl });
  await revokeToken({ revocationEndpoint: meta.revocationEndpoint, clientId, token: 'r', hint: 'refresh_token' }, { fetchImpl });
  await fetchEmail({ userinfoEndpoint: meta.userinfoEndpoint, accessToken: 'a' }, { fetchImpl });
  const issuerRequests = requests.filter((r) => r.url.startsWith(ISSUER));
  assert.equal(issuerRequests.length, 6);
  for (const r of issuerRequests) assert.equal(Object.keys(r.headers).some((h) => h.toLowerCase() === EXTRA), false, r.url);
  assert.equal(requests.filter((r) => r.headers[EXTRA]).length, 1);
});

test('pkcePair challenge is base64url(sha256(verifier)) and the verifier is 43-128 url-safe characters', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    seen.add(verifier);
  }
  assert.equal(seen.size, 20);
});

test('exchangeCode sends code_verifier, client_id, redirect_uri and resource and returns the tokens', async () => {
  const { fetchImpl, requests } = fakeFetch({ [TOKEN_ENDPOINT]: json({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }) });
  const before = Date.now();
  const tokens = await exchangeCode(
    { tokenEndpoint: TOKEN_ENDPOINT, clientId: 'client_cli', code: 'the-code', verifier: 'the-verifier', redirectUri: 'http://127.0.0.1:53437/callback', resource: `${HEADJACK}/api` },
    { fetchImpl },
  );
  const after = Date.now();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(requests[0].body, {
    grant_type: 'authorization_code',
    code: 'the-code',
    code_verifier: 'the-verifier',
    client_id: 'client_cli',
    redirect_uri: 'http://127.0.0.1:53437/callback',
    resource: `${HEADJACK}/api`,
  });
  assert.equal(tokens.accessToken, 'acc');
  assert.equal(tokens.refreshToken, 'ref');
  assert.ok(tokens.expiresAt >= before + 3_600_000 && tokens.expiresAt <= after + 3_600_000);
});

test('exchangeCode refuses a response without both tokens', async () => {
  for (const body of [{ access_token: 'a', expires_in: 60 }, { refresh_token: 'r', expires_in: 60 }, { access_token: 'a', refresh_token: 'r' }, {}]) {
    const { fetchImpl } = fakeFetch({ [TOKEN_ENDPOINT]: json(body) });
    await assert.rejects(
      exchangeCode({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', resource: 'r' }, { fetchImpl }),
      UserError,
      JSON.stringify(body),
    );
  }
});

test('token endpoint errors name the endpoint and the OAuth error code but never a token', async () => {
  const { fetchImpl } = fakeFetch({ [TOKEN_ENDPOINT]: json({ error: 'invalid_grant', error_description: 'refresh token sekret-refresh is expired' }, 400) });
  await assert.rejects(
    refreshTokens({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', refreshToken: 'sekret-refresh', resource: 'r' }, { fetchImpl }),
    (e) => e instanceof UserError
      && !e.message.includes('\n')
      && e.message.includes(TOKEN_ENDPOINT)
      && e.message.includes('invalid_grant')
      && !e.message.includes('sekret-refresh'),
  );
});

test('only an issuer rejection carries the oauthRefusal marker', async () => {
  const args = { tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', refreshToken: 'r', resource: 'r' };
  for (const [status, expected] of [[400, true], [401, true], [403, true], [404, true], [408, false], [429, false], [500, false], [503, false]]) {
    const { fetchImpl } = fakeFetch({ [TOKEN_ENDPOINT]: json({ error: 'invalid_grant' }, status) });
    await assert.rejects(refreshTokens(args, { fetchImpl }), (e) => e instanceof UserError && e.oauthRefusal === expected, `HTTP ${status}`);
  }
  // A transport failure, a timeout and an incomplete 200 are not refusals either.
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(refreshTokens(args, { fetchImpl: down }), (e) => e instanceof UserError && !e.oauthRefusal);
  const silent = () => new Promise(() => {});
  await assert.rejects(refreshTokens(args, { fetchImpl: silent, timeoutMs: 50 }), (e) => e instanceof UserError && !e.oauthRefusal);
  const { fetchImpl: incomplete } = fakeFetch({ [TOKEN_ENDPOINT]: json({ access_token: 'a' }) });
  await assert.rejects(refreshTokens(args, { fetchImpl: incomplete }), (e) => e instanceof UserError && !e.oauthRefusal);
});

test('refresh sends resource and client_id', async () => {
  const { fetchImpl, requests } = fakeFetch({ [TOKEN_ENDPOINT]: json({ access_token: 'acc2', refresh_token: 'ref2', expires_in: 120 }) });
  const tokens = await refreshTokens({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'client_cli', refreshToken: 'ref1', resource: `${HEADJACK}/api` }, { fetchImpl });
  assert.deepEqual(requests[0].body, { grant_type: 'refresh_token', refresh_token: 'ref1', client_id: 'client_cli', resource: `${HEADJACK}/api` });
  assert.equal(tokens.accessToken, 'acc2');
  assert.equal(tokens.refreshToken, 'ref2');
  assert.ok(tokens.expiresAt > Date.now());
});

test('refresh without a new refresh token keeps the old one', async () => {
  const { fetchImpl } = fakeFetch({ [TOKEN_ENDPOINT]: json({ access_token: 'acc2', expires_in: 120 }) });
  const tokens = await refreshTokens({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', refreshToken: 'ref1', resource: 'r' }, { fetchImpl });
  assert.equal(tokens.refreshToken, 'ref1');
  assert.equal(tokens.accessToken, 'acc2');
});

test('refresh aborts after timeoutMs', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const started = Date.now();
  await assert.rejects(
    refreshTokens({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', refreshToken: 'ref1', resource: 'r' }, { fetchImpl, timeoutMs: 30 }),
    (e) => e instanceof UserError && e.message.includes(TOKEN_ENDPOINT) && !e.message.includes('ref1'),
  );
  assert.ok(Date.now() - started < 2000);
});

test('refresh times out even when the transport ignores the abort signal', async () => {
  const fetchImpl = () => new Promise(() => {});
  await assert.rejects(
    refreshTokens({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', refreshToken: 'ref1', resource: 'r' }, { fetchImpl, timeoutMs: 30 }),
    UserError,
  );
});

test('authServerMetadata times out after timeoutMs even when the transport ignores the signal', { timeout: 5000 }, async () => {
  const started = Date.now();
  await assert.rejects(
    authServerMetadata(ISSUER, { fetchImpl: () => new Promise(() => {}), timeoutMs: 30 }),
    (e) => e instanceof UserError && !e.message.includes('\n') && e.message.includes(`${ISSUER}/.well-known/`) && /did not answer within 1s/.test(e.message),
  );
  assert.ok(Date.now() - started < 2000);
});

test('discoverApi, exchangeCode and fetchEmail time out with a one-line error naming the URL', { timeout: 5000 }, async () => {
  const never = () => new Promise(() => {});
  const discoveryUrl = `${HEADJACK}/.well-known/oauth-protected-resource/api`;
  const userinfo = `${ISSUER}/oauth/userinfo`;
  const oneLine = (url) => (e) => e instanceof UserError && !e.message.includes('\n') && e.message.includes(url) && /did not answer within 1s/.test(e.message) && !e.message.includes('secret');
  await assert.rejects(discoverApi(HEADJACK, { fetchImpl: never, timeoutMs: 30 }), oneLine(discoveryUrl));
  await assert.rejects(
    exchangeCode({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', code: 'secret', verifier: 'secret', redirectUri: 'http://127.0.0.1:1/callback', resource: 'r' }, { fetchImpl: never, timeoutMs: 30 }),
    oneLine(TOKEN_ENDPOINT),
  );
  await assert.rejects(fetchEmail({ userinfoEndpoint: userinfo, accessToken: 'secret' }, { fetchImpl: never, timeoutMs: 30 }), oneLine(userinfo));
  // A body that never ends is bounded too.
  const stalledBody = async () => ({ ok: true, status: 200, json: never, body: null });
  await assert.rejects(discoverApi(HEADJACK, { fetchImpl: stalledBody, timeoutMs: 30 }), oneLine(discoveryUrl));
});

test('discoverApi, exchangeCode and fetchEmail are bounded by default', async () => {
  const signals = [];
  const answer = (body) => async (_url, init = {}) => { signals.push(init.signal); return json(body); };
  await discoverApi(HEADJACK, { fetchImpl: answer(protectedResource()) });
  await exchangeCode({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', resource: 'r' }, { fetchImpl: answer({ access_token: 'a', refresh_token: 'r', expires_in: 60 }) });
  await fetchEmail({ userinfoEndpoint: `${ISSUER}/oauth/userinfo`, accessToken: 'a' }, { fetchImpl: answer({ email: 'a@example.invalid' }) });
  assert.equal(signals.length, 3);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

test('authServerMetadata bounds both discovery requests by default', async () => {
  const { fetchImpl: answer } = fakeFetch(issuerRoutes());
  const signals = [];
  await authServerMetadata(ISSUER, { fetchImpl: (url, init = {}) => { signals.push(init.signal); return answer(url, init); } });
  assert.equal(signals.length, 2);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

test('revoke sends token_type_hint, token and client_id and reports success', async () => {
  const revocationEndpoint = `${ISSUER}/oauth/token/revoke`;
  const { fetchImpl, requests } = fakeFetch({ [revocationEndpoint]: new Response(null, { status: 200 }) });
  assert.equal(await revokeToken({ revocationEndpoint, clientId: 'client_cli', token: 'ref1', hint: 'refresh_token' }, { fetchImpl }), true);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, { token: 'ref1', token_type_hint: 'refresh_token', client_id: 'client_cli' });
});

test('revoke reports failure as false instead of throwing', async () => {
  const revocationEndpoint = `${ISSUER}/oauth/token/revoke`;
  const { fetchImpl: rejecting } = fakeFetch({ [revocationEndpoint]: new Response('no', { status: 400 }) });
  assert.equal(await revokeToken({ revocationEndpoint, clientId: 'c', token: 't', hint: 'access_token' }, { fetchImpl: rejecting }), false);
  const down = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await revokeToken({ revocationEndpoint, clientId: 'c', token: 't', hint: 'access_token' }, { fetchImpl: down }), false);
});

test('revoke times out instead of stalling logout', async () => {
  const started = Date.now();
  assert.equal(await revokeToken({ revocationEndpoint: `${ISSUER}/oauth/token/revoke`, clientId: 'c', token: 't', hint: 'refresh_token' }, { fetchImpl: () => new Promise(() => {}), timeoutMs: 30 }), false);
  assert.ok(Date.now() - started < 2000);
});

test('a body that stalls past the timeout is reported as a timeout, not as bad JSON', async () => {
  const stalled = () => ({ ok: true, status: 200, json: () => new Promise(() => {}), body: null });
  await assert.rejects(
    refreshTokens({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', refreshToken: 'r', resource: 'r' }, { fetchImpl: async () => stalled(), timeoutMs: 30 }),
    (e) => e instanceof UserError && /did not answer within 1s/.test(e.message) && !/JSON/.test(e.message),
  );
  const abortedBody = () => ({ ok: true, status: 200, json: () => Promise.reject(new DOMException('aborted', 'AbortError')), body: null });
  await assert.rejects(
    refreshTokens({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c', refreshToken: 'r', resource: 'r' }, { fetchImpl: async () => abortedBody(), timeoutMs: 30 }),
    (e) => e instanceof UserError && /did not answer/.test(e.message) && !/NaN/.test(e.message),
  );
});

test('a timeout without a configured limit never prints NaN', async () => {
  const abortedBody = () => ({ ok: true, status: 200, json: () => Promise.reject(new DOMException('aborted', 'AbortError')), body: null });
  await assert.rejects(
    fetchEmail({ userinfoEndpoint: `${ISSUER}/oauth/userinfo`, accessToken: 'a' }, { fetchImpl: async () => abortedBody() }),
    (e) => e instanceof UserError && !/NaN/.test(e.message) && e.message.includes(`${ISSUER}/oauth/userinfo`),
  );
  await assert.rejects(
    discoverApi(HEADJACK, { fetchImpl: async () => { throw new DOMException('aborted', 'AbortError'); } }),
    (e) => e instanceof UserError && !/NaN/.test(e.message) && !e.message.includes('\n'),
  );
});

test('fetchEmail sends the access token as a bearer and returns the email', async () => {
  const userinfoEndpoint = `${ISSUER}/oauth/userinfo`;
  const { fetchImpl, requests } = fakeFetch({ [userinfoEndpoint]: json({ sub: 'user_1', email: 'dev@example.invalid' }) });
  assert.equal(await fetchEmail({ userinfoEndpoint, accessToken: 'acc' }, { fetchImpl }), 'dev@example.invalid');
  assert.equal(requests[0].headers.authorization, 'Bearer acc');
});

test('fetchEmail refuses a response without an email and never echoes the token', async () => {
  const userinfoEndpoint = `${ISSUER}/oauth/userinfo`;
  for (const res of [json({ sub: 'user_1' }), new Response('no', { status: 401 })]) {
    const { fetchImpl } = fakeFetch({ [userinfoEndpoint]: res });
    await assert.rejects(
      fetchEmail({ userinfoEndpoint, accessToken: 'sekret-access' }, { fetchImpl }),
      (e) => e instanceof UserError && e.message.includes(userinfoEndpoint) && !e.message.includes('sekret-access'),
    );
  }
});
