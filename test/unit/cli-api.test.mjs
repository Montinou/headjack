import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApi, ApiError } from '../../cli/api.mjs';
import { loadRemote, loadUrl } from '../../cli/config.mjs';
import { readCredential, writeOAuthCredential } from '../../cli/credentials.mjs';
import { UserError } from '../../lib/errors.mjs';

const HEADJACK = 'https://headjack.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sv-cli-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const oauth = (over = {}) => ({
  kind: 'oauth',
  source: 'file',
  issuer: ISSUER,
  clientId: 'client_cli',
  resource: `${HEADJACK}/api`,
  email: 'user@example.invalid',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3600e3,
  ...over,
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Headjack API plus a rotating authorization server in one fetch fake. `accepts` lists the bearers the API accepts.
function world({ accepts = ['access-2'] } = {}) {
  const requests = [];
  const refreshes = [];
  let n = 1;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: TOKEN_ENDPOINT,
        revocation_endpoint: `${ISSUER}/oauth/token/revoke`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (u === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, userinfo_endpoint: `${ISSUER}/oauth/userinfo` });
    if (u === TOKEN_ENDPOINT) {
      refreshes.push(Object.fromEntries(init.body));
      n += 1;
      return json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, token_type: 'Bearer' });
    }
    requests.push({ url: u, headers: init.headers ?? {}, init });
    const bearer = init.headers?.authorization?.replace(/^Bearer /, '');
    if (!accepts.includes(bearer)) return json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    return json({ results: [] });
  };
  return { fetchImpl, requests, refreshes };
}

async function storedApi(t, { credential = oauth(), env = {}, accepts, headers } = {}) {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, credential);
  const w = world({ accepts });
  const stored = await readCredential({ env: {}, dir });
  return { ...w, dir, stored, api: createApi({ url: HEADJACK, credential: stored, dir, fetchImpl: w.fetchImpl, env, headers }) };
}

test('an expired OAuth credential is refreshed once and the refreshed one is reused', async (t) => {
  const { api, requests, refreshes } = await storedApi(t, { credential: oauth({ expiresAt: Date.now() + 1000 }) });
  await api.search('a');
  await api.search('b');
  assert.equal(refreshes.length, 1);
  assert.deepEqual(requests.map((r) => r.headers.authorization), ['Bearer access-2', 'Bearer access-2']);
});

test('a fresh OAuth credential is sent as is, without any refresh', async (t) => {
  const { api, requests, refreshes } = await storedApi(t, { accepts: ['access-1'] });
  await api.search('a');
  assert.equal(refreshes.length, 0);
  assert.equal(requests[0].headers.authorization, 'Bearer access-1');
});

test('installEvent sends the OAuth bearer, refreshed when needed', async (t) => {
  const { api, requests, refreshes } = await storedApi(t, { credential: oauth({ expiresAt: Date.now() + 1000 }) });
  assert.equal(await api.installEvent({ slug: 's', kind: 'skill', source: 'plan' }), undefined);
  assert.equal(refreshes.length, 1);
  assert.equal(requests[0].url, `${HEADJACK}/api/events/install`);
  assert.equal(requests[0].headers.authorization, 'Bearer access-2');
  assert.equal(requests[0].init.method, 'POST');
});

test('installEvent stays advisory when the credential cannot be refreshed', async (t) => {
  const dir = await tempDir(t);
  const credential = oauth({ expiresAt: Date.now() + 1000 });
  const api = createApi({ url: HEADJACK, credential, dir, fetchImpl: world().fetchImpl, env: {} });
  assert.equal(await api.installEvent({ slug: 's', kind: 'skill', source: 'plan' }), undefined);
});

test('a 401 forces one refresh and retries the request once', async (t) => {
  const { api, requests, refreshes } = await storedApi(t);
  assert.deepEqual(await api.search('a'), []);
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].refresh_token, 'refresh-1');
  assert.deepEqual(requests.map((r) => r.headers.authorization), ['Bearer access-1', 'Bearer access-2']);
  await api.search('b');
  assert.equal(refreshes.length, 1);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer access-2');
});

test('a second 401 surfaces the login hint after a single retry', async (t) => {
  const { api, requests, refreshes } = await storedApi(t, { accepts: [] });
  await assert.rejects(api.search('a'), (e) => e instanceof ApiError && e.status === 401 && e.message.endsWith('run headjack login'));
  assert.equal(refreshes.length, 1);
  assert.equal(requests.length, 2);
});

test('a 401 with an env API key names HEADJACK_TOKEN and never refreshes', async () => {
  const w = world({ accepts: [] });
  const api = createApi({ url: HEADJACK, credential: { kind: 'api-key', token: 'ak_env', source: 'env' }, dir: '/unused', fetchImpl: w.fetchImpl, env: {} });
  await assert.rejects(api.search('a'), (e) => e instanceof ApiError && e.status === 401 && e.message === 'no: check HEADJACK_TOKEN');
  assert.equal(w.requests.length, 1);
  assert.equal(w.refreshes.length, 0);
});

test('a 401 with a file API key says to run headjack login', async () => {
  const w = world({ accepts: [] });
  const api = createApi({ url: HEADJACK, credential: { kind: 'api-key', token: 'ak_file', source: 'file' }, dir: '/unused', fetchImpl: w.fetchImpl, env: {} });
  await assert.rejects(api.search('a'), (e) => e instanceof ApiError && e.status === 401 && e.message === 'no: run headjack login');
  assert.equal(w.requests.length, 1);
});

test('an OAuth credential for another server is refused, including after loadRemote normalizes the URL', async (t) => {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, oauth({ resource: 'https://other.example.invalid/api' }));
  const refused = (e) => e instanceof UserError && e.message === 'the saved login is for another server: run headjack login --force';
  const noNetwork = async (url) => { throw new Error(`unexpected request to ${url}`); };
  const wrongServer = await loadRemote({ env: { HEADJACK_URL: `${HEADJACK}/` }, dir });
  assert.throws(() => createApi({ ...wrongServer, dir, fetchImpl: noNetwork }), refused);
  await writeOAuthCredential(dir, oauth());
  const right = await loadRemote({ env: { HEADJACK_URL: `${HEADJACK}//` }, dir });
  const api = createApi({ ...right, dir, fetchImpl: world({ accepts: ['access-1'] }).fetchImpl });
  assert.deepEqual(await api.search('a'), []);
});

test('loadRemote returns the url and the credential, and owns the not-logged-in message', async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(await loadRemote({ env: { HEADJACK_URL: `${HEADJACK}/`, HEADJACK_TOKEN: 'ak' }, dir }), {
    url: HEADJACK, credential: { kind: 'api-key', token: 'ak', source: 'env' },
  });
  await assert.rejects(
    loadRemote({ env: { HEADJACK_URL: HEADJACK }, dir }),
    (e) => e instanceof UserError && e.message === 'not logged in: run headjack login, or set HEADJACK_TOKEN (an API key)',
  );
});

test('loadUrl needs no credential and strips trailing slashes', () => {
  assert.equal(loadUrl({ HEADJACK_URL: `${HEADJACK}///` }), HEADJACK);
  assert.throws(() => loadUrl({}), (e) => e instanceof UserError && e.message === 'HEADJACK_URL is not set (for example https://headjack.example.invalid)');
});

test('loadUrl canonicalizes: lowercase host, no default port, no trailing slash, a path is kept', () => {
  for (const [given, expected] of [
    ['https://Headjack.Example.invalid', HEADJACK],
    ['HTTPS://HEADJACK.EXAMPLE.INVALID:443/', HEADJACK],
    [`${HEADJACK}:443`, HEADJACK],
    ['https://headjack.example.invalid:8443//', 'https://headjack.example.invalid:8443'],
    ['http://LOCALHOST:80', 'http://localhost'],
    ['https://headjack.example.invalid/vault/', 'https://headjack.example.invalid/vault'],
  ]) assert.equal(loadUrl({ HEADJACK_URL: given }), expected, given);
});

test('loadUrl refuses credentials, a query and a fragment without echoing them', () => {
  for (const bad of ['https://user:hunter2@headjack.example.invalid', 'https://hunter2@headjack.example.invalid', 'https://headjack.example.invalid/?k=hunter2', 'https://headjack.example.invalid/#hunter2']) {
    assert.throws(
      () => loadUrl({ HEADJACK_URL: bad }),
      (e) => e instanceof UserError && e.message === 'HEADJACK_URL must be a plain https origin (or http on loopback) without credentials, query or fragment' && !e.message.includes('hunter2'),
      bad,
    );
  }
});

test('a saved login binds to the server whatever the case, default port or trailing slash of either side', async (t) => {
  const dir = await tempDir(t);
  const noNetwork = async (url) => { throw new Error(`unexpected request to ${url}`); };
  for (const [resource, envUrl] of [
    ['https://Headjack.Example.invalid:443/api', HEADJACK],
    [`${HEADJACK}/api/`, `${HEADJACK}/`],
    [`${HEADJACK}/api`, 'HTTPS://HEADJACK.example.invalid:443'],
  ]) {
    await writeOAuthCredential(dir, oauth({ resource }));
    const remote = await loadRemote({ env: { HEADJACK_URL: envUrl }, dir });
    assert.doesNotThrow(() => createApi({ ...remote, dir, fetchImpl: noNetwork }), `${resource} vs ${envUrl}`);
  }
  await writeOAuthCredential(dir, oauth({ resource: 'https://headjack.example.invalid:8443/api' }));
  const other = await loadRemote({ env: { HEADJACK_URL: HEADJACK }, dir });
  assert.throws(() => createApi({ ...other, dir, fetchImpl: noNetwork }), (e) => e instanceof UserError && /another server/.test(e.message));
});

test('loadUrl requires https, or http on a loopback host, and never echoes the value', () => {
  for (const ok of [HEADJACK, 'http://127.0.0.1:3000', 'http://localhost:3000/', 'http://[::1]:3000']) assert.equal(loadUrl({ HEADJACK_URL: ok }), ok.replace(/\/+$/, ''), ok);
  for (const bad of ['http://headjack.example.invalid', 'http://user:hunter2@headjack.example.invalid', 'ftp://127.0.0.1', 'headjack.example.invalid', 'file:///etc/passwd']) {
    assert.throws(
      () => loadUrl({ HEADJACK_URL: bad }),
      (e) => e instanceof UserError && /^HEADJACK_URL must be an https URL/.test(e.message) && !e.message.includes('hunter2') && !e.message.includes('\n'),
      bad,
    );
  }
});

test('createApi sends the static headers option on every request', async (t) => {
  const headers = { cookie: 'pinned=arm', 'x-extra': 'one' };
  const { api, requests } = await storedApi(t, { accepts: ['access-1'], headers });
  await api.search('a');
  await api.installEvent({ slug: 's', kind: 'skill', source: 'plan' });
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.headers.cookie, 'pinned=arm');
    assert.equal(r.headers['x-extra'], 'one');
    assert.equal(r.headers.authorization, 'Bearer access-1');
  }
});

test('the static headers never replace the bearer', async (t) => {
  const { api, requests } = await storedApi(t, { accepts: ['access-1'], headers: { authorization: 'Bearer other' } });
  await api.search('a');
  assert.equal(requests[0].headers.authorization, 'Bearer access-1');
});

test('the session id header still rides along with an OAuth bearer', async (t) => {
  const { api, requests } = await storedApi(t, { accepts: ['access-1'], env: { CLAUDE_CODE_SESSION_ID: 'abc-123' } });
  await api.search('a');
  assert.equal(requests[0].headers['x-headjack-session'], 'abc-123');
  assert.equal(requests[0].headers.authorization, 'Bearer access-1');
});
