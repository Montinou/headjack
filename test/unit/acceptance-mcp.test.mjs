// scripts/acceptance-mcp.mjs (spec §6 steps 4-7): the MCP token, tool call, REST, revocation, refresh and paced-search
// client used by the preview acceptance. Fake fetch and a fake clock; the only real socket is the loopback callback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeOAuthCredential } from '../../cli/credentials.mjs';
import { UserError } from '../../lib/errors.mjs';
import {
  callTool,
  main,
  pacedSearch,
  restStatus,
  revokeGrant,
  tryRefresh,
} from '../../scripts/acceptance-mcp.mjs';

const ISSUER = 'https://auth.example';
const CLIENT_ID = 'client_mcp_fixture';
const RESOURCE = 'https://vault.example/mcp';
const ACCESS = ['access', 'token', 'fixture'].join('-');
const REFRESH = ['refresh', 'token', 'fixture'].join('-');
const ROTATED = ['rotated', 'access', 'fixture'].join('-');
const ROTATED_REFRESH = ['rotated', 'refresh', 'fixture'].join('-');
const SECRETS = [ACCESS, REFRESH, ROTATED, ROTATED_REFRESH];
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Authorization server fake: discovery, token and revocation endpoints; every request is recorded.
function fakeIssuer({ tokenStatus = 200, tokenError = 'invalid_grant', revokeStatus = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
    requests.push({ url: url.href, method: init.method ?? 'GET', headers: init.headers, body });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: ISSUER,
        code_challenge_methods_supported: ['S256'],
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
      });
    }
    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: ISSUER, userinfo_endpoint: `${ISSUER}/oauth/userinfo` });
    if (url.pathname === '/oauth/token') {
      if (tokenStatus !== 200) return tokenError === null ? new Response(null, { status: tokenStatus }) : json({ error: tokenError }, tokenStatus);
      const rotating = body.grant_type === 'refresh_token';
      return json({ access_token: rotating ? ROTATED : ACCESS, refresh_token: rotating ? ROTATED_REFRESH : REFRESH, expires_in: 3600 });
    }
    if (url.pathname === '/oauth/revoke') return new Response(null, { status: revokeStatus });
    throw new Error(`unexpected request ${url.href}`);
  };
  return { fetchImpl, requests };
}

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), 'acceptance-mcp-'));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function ownTokenFile(dir, extra = {}) {
  const file = path.join(dir, 'mcp-token.json');
  await writeFile(file, JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, client_id: CLIENT_ID, resource: RESOURCE, issuer: ISSUER, ...extra }), { mode: 0o600 });
  return file;
}

function collector() {
  const lines = [];
  const waiters = [];
  const log = (line) => {
    lines.push(String(line));
    for (const w of waiters.splice(0)) w();
  };
  const until = async (predicate) => {
    while (!lines.some(predicate)) await new Promise((resolve) => waiters.push(resolve));
    return lines.find(predicate);
  };
  return { lines, log, until };
}

const noSecrets = (text) => SECRETS.every((secret) => !text.includes(secret));

test('token flow sends resource and code_verifier, writes a mode 600 file and prints only the URL and "token written"', async () => {
  const dir = await tmp();
  try {
    const out = path.join(dir, 'out', 'mcp-token.json');
    const port = await freePort();
    const { fetchImpl, requests } = fakeIssuer();
    const output = collector();
    const done = main(['token', '--issuer', ISSUER, '--client-id', CLIENT_ID, '--resource', RESOURCE, '--out', out], {
      fetchImpl, log: output.log, error: output.log, ports: [port],
    });
    const printed = await output.until((line) => line.startsWith(`${ISSUER}/oauth/authorize`));
    const authorize = new URL(printed);
    assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(authorize.searchParams.get('scope'), 'skills:read offline_access');
    assert.equal(authorize.searchParams.get('resource'), RESOURCE);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('redirect_uri'), `http://localhost:${port}/callback`);
    const state = authorize.searchParams.get('state');

    const callback = await fetch(`http://127.0.0.1:${port}/callback?code=code-fixture&state=${state}`);
    assert.equal(callback.status, 200);
    assert.equal(await done, 0);

    const exchange = requests.find((r) => r.url === `${ISSUER}/oauth/token`);
    assert.equal(exchange.body.grant_type, 'authorization_code');
    assert.equal(exchange.body.resource, RESOURCE);
    assert.equal(exchange.body.client_id, CLIENT_ID);
    assert.equal(exchange.body.code, 'code-fixture');
    assert.equal(exchange.body.redirect_uri, `http://localhost:${port}/callback`);
    assert.match(exchange.body.code_verifier, /^[A-Za-z0-9_-]{43}$/);

    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), {
      access_token: ACCESS, refresh_token: REFRESH, client_id: CLIENT_ID, resource: RESOURCE, issuer: ISSUER,
    });
    assert.equal(output.lines.length, 2);
    assert.equal(output.lines[1], 'token written');
    assert.ok(noSecrets(output.lines.join('\n')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function refusedOut(out) {
  const { fetchImpl, requests } = fakeIssuer();
  const output = collector();
  const code = await main(['token', '--issuer', ISSUER, '--client-id', CLIENT_ID, '--resource', RESOURCE, '--out', out], {
    fetchImpl, log: output.log, error: output.log,
  });
  assert.equal(code, 2, out);
  assert.equal(output.lines.length, 1);
  assert.match(output.lines[0], /outside the repository/);
  assert.deepEqual(requests, [], 'refused before any request');
}

test('token refuses an output file inside the repository, wherever the test runs from', async () => {
  await refusedOut(path.join(REPO_ROOT, 'mcp-token.json'));
  await refusedOut(path.join(REPO_ROOT, 'not-yet', 'deeper', 'mcp-token.json'));
  // A directory named like `..x` is inside, not a parent.
  await refusedOut(path.join(REPO_ROOT, '..x', 'mcp-token.json'));
});

test('token refuses an output file under any other git checkout or worktree, through symlinks too', async () => {
  const dir = await tmp();
  try {
    const checkout = path.join(dir, 'checkout');
    const worktree = path.join(dir, 'worktree');
    await mkdir(path.join(checkout, '.git'), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/w\n');
    await refusedOut(path.join(checkout, 'a', 'b', 'mcp-token.json'));
    await refusedOut(path.join(worktree, 'mcp-token.json'));
    const link = path.join(dir, 'link');
    await symlink(checkout, link);
    await refusedOut(path.join(link, 'mcp-token.json'));
    await refusedOut(path.join(link, 'new', 'mcp-token.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Something else (Claude Code, for one) holding the callback port on IPv6: the 127.0.0.1 bind would still succeed.
async function holdPort(host) {
  const server = createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
  return { port, close: () => new Promise((resolve) => { server.close(() => resolve()); }) };
}

for (const host of ['::1', '::']) {
  test(`token refuses a callback port already in use on ${host}, naming the port`, async (t) => {
    let holder;
    try {
      holder = await holdPort(host);
    } catch {
      t.skip('IPv6 is not available here');
      return;
    }
    const dir = await tmp();
    try {
      const { fetchImpl, requests } = fakeIssuer();
      const output = collector();
      const code = await main(['token', '--issuer', ISSUER, '--client-id', CLIENT_ID, '--resource', RESOURCE, '--out', path.join(dir, 'mcp-token.json')], {
        fetchImpl, log: output.log, error: output.log, ports: [holder.port],
      });
      assert.equal(code, 2);
      assert.equal(output.lines.length, 1);
      assert.ok(output.lines[0].includes(String(holder.port)));
      assert.match(output.lines[0], /in use/);
      assert.deepEqual(requests, []);
    } finally {
      await holder.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('callTool sends initialize then tools/call with the bearer and reads a JSON or event-stream reply', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), method: init.method, headers: init.headers, body });
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'headjack' } } });
    const message = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"results":[]}' }], structuredContent: { results: [] } } });
    return new Response(`event: message\ndata: ${message}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await callTool({ url: RESOURCE, token: ACCESS, tool: 'search_skills', args: { query: 'discover' } }, { fetchImpl });
  assert.deepEqual(result.structuredContent, { results: [] });
  assert.deepEqual(requests.map((r) => r.body.method), ['initialize', 'tools/call']);
  assert.deepEqual(requests[1].body.params, { name: 'search_skills', arguments: { query: 'discover' } });
  for (const r of requests) {
    assert.equal(r.url, RESOURCE);
    assert.equal(r.method, 'POST');
    assert.equal(r.headers.authorization, `Bearer ${ACCESS}`);
    assert.equal(r.headers.accept, 'application/json, text/event-stream');
    assert.equal(r.headers['content-type'], 'application/json');
  }
  assert.ok(requests[1].headers['mcp-protocol-version']);
});

test('call prints the tool result without the token, and a rejection is a one-line error without it', async () => {
  const dir = await tmp();
  try {
    const file = await ownTokenFile(dir);
    const ok = collector();
    const fetchOk = async (url, init) => {
      const body = JSON.parse(init.body);
      return json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? {} : { structuredContent: { results: ['a'] } } });
    };
    assert.equal(await main(['call', '--url', RESOURCE, '--token-file', file, '--tool', 'search_skills', '--args', '{"query":"x"}'], { fetchImpl: fetchOk, log: ok.log, error: ok.log }), 0);
    assert.deepEqual(JSON.parse(ok.lines.join('\n')), { structuredContent: { results: ['a'] } });
    assert.ok(noSecrets(ok.lines.join('\n')));

    const bad = collector();
    const fetch401 = async (url, init) => new Response(`unauthorized for ${init.headers.authorization}`, { status: 401 });
    assert.equal(await main(['call', '--url', RESOURCE, '--token-file', file, '--tool', 'search_skills', '--args', '{}'], { fetchImpl: fetch401, log: bad.log, error: bad.log }), 2);
    assert.equal(bad.lines.length, 1);
    assert.match(bad.lines[0], /HTTP 401/);
    assert.ok(noSecrets(bad.lines.join('\n')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rest reads a CLI credential file and prints only the status', async () => {
  const dir = await tmp();
  try {
    await writeOAuthCredential(dir, {
      issuer: ISSUER, clientId: 'client_cli_fixture', resource: 'https://vault.example/api', email: 'a@example.test',
      accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 3600000,
    });
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), headers: init.headers });
      return new Response('{"private":"body"}', { status: 200 });
    };
    const output = collector();
    const code = await main(['rest', '--url', 'https://vault.example', '--token-file', path.join(dir, 'token'), '--path', '/api/updates'], {
      fetchImpl, log: output.log, error: output.log,
    });
    assert.equal(code, 0);
    assert.deepEqual(output.lines, ['status 200']);
    assert.equal(requests[0].url, 'https://vault.example/api/updates');
    assert.equal(requests[0].headers.authorization, `Bearer ${ACCESS}`);

    const own = await ownTokenFile(dir);
    assert.equal(await restStatus({ url: 'https://vault.example/', token: ACCESS, path: '/api/updates' }, { fetchImpl: async () => new Response(null, { status: 401 }) }), 401);
    const rejected = collector();
    assert.equal(await main(['rest', '--url', 'https://vault.example', '--token-file', own, '--path', '/api/updates'], { fetchImpl: async () => new Response(null, { status: 401 }), log: rejected.log, error: rejected.log }), 0);
    assert.deepEqual(rejected.lines, ['status 401']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rest requires a single-slash absolute path that stays on the --url origin', async () => {
  const dir = await tmp();
  try {
    const file = await ownTokenFile(dir);
    const fetchImpl = async () => { throw new Error('must not be called'); };
    for (const bad of ['', 'api/updates', '//evil.example/x', '/\\evil.example/x', 'https://evil.example/x', '@evil.example']) {
      await assert.rejects(restStatus({ url: 'https://vault.example', token: ACCESS, path: bad }, { fetchImpl }), (e) => e instanceof UserError, JSON.stringify(bad));
      const output = collector();
      assert.equal(await main(['rest', '--url', 'https://vault.example', '--token-file', file, '--path', bad], { fetchImpl, log: output.log, error: output.log }), 2);
      assert.equal(output.lines.length, 1);
      assert.match(output.lines[0], /--path/);
      assert.ok(noSecrets(output.lines[0]));
    }
    await assert.rejects(restStatus({ url: 'not a url', token: ACCESS, path: '/api/updates' }, { fetchImpl }), (e) => e instanceof UserError);
    const seen = [];
    const ok = async (url) => { seen.push(String(url)); return new Response(null, { status: 200 }); };
    assert.equal(await restStatus({ url: 'https://vault.example/', token: ACCESS, path: '/api/updates?x=1' }, { fetchImpl: ok }), 200);
    assert.deepEqual(seen, ['https://vault.example/api/updates?x=1']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a token file that is not JSON or lacks a field is a one-line error naming the file', async () => {
  const dir = await tmp();
  try {
    const empty = path.join(dir, 'empty');
    await writeFile(empty, 'not json', { mode: 0o600 });
    const partial = await ownTokenFile(dir, { refresh_token: undefined });
    for (const file of [empty, partial, path.join(dir, 'missing')]) {
      const output = collector();
      const code = await main(['rest', '--url', 'https://vault.example', '--token-file', file, '--path', '/api/updates'], {
        fetchImpl: async () => { throw new Error('must not be called'); }, log: output.log, error: output.log,
      });
      assert.equal(code, 2);
      assert.equal(output.lines.length, 1);
      assert.ok(output.lines[0].includes(file));
      assert.ok(noSecrets(output.lines[0]));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('revoke revokes the refresh token before the access token and prints no token', async () => {
  const dir = await tmp();
  try {
    const file = await ownTokenFile(dir);
    const { fetchImpl, requests } = fakeIssuer();
    const output = collector();
    assert.equal(await main(['revoke', '--token-file', file], { fetchImpl, log: output.log, error: output.log }), 0);
    const revocations = requests.filter((r) => r.url === `${ISSUER}/oauth/revoke`);
    assert.deepEqual(revocations.map((r) => [r.body.token_type_hint, r.body.token]), [['refresh_token', REFRESH], ['access_token', ACCESS]]);
    assert.ok(revocations.every((r) => r.body.client_id === CLIENT_ID));
    assert.ok(noSecrets(output.lines.join('\n')));

    const failing = fakeIssuer({ revokeStatus: 500 });
    assert.deepEqual(await revokeGrant({ file }, { fetchImpl: failing.fetchImpl }), { refresh: false, access: false });
    const refused = collector();
    assert.equal(await main(['revoke', '--token-file', file], { fetchImpl: failing.fetchImpl, log: refused.log, error: refused.log }), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh reports success without printing tokens and writes the rotated pair back, mode 600, keeping other keys', async () => {
  const dir = await tmp();
  try {
    const file = await ownTokenFile(dir, { note: 'kept' });
    const good = fakeIssuer();
    assert.deepEqual(await tryRefresh({ file }, { fetchImpl: good.fetchImpl }), { refreshed: true });
    const grant = good.requests.find((r) => r.url === `${ISSUER}/oauth/token`);
    assert.deepEqual([grant.body.grant_type, grant.body.refresh_token, grant.body.client_id, grant.body.resource], ['refresh_token', REFRESH, CLIENT_ID, RESOURCE]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      access_token: ROTATED, refresh_token: ROTATED_REFRESH, client_id: CLIENT_ID, resource: RESOURCE, issuer: ISSUER, note: 'kept',
    });

    // The next call uses the live pair, and so does a later revoke.
    const okOut = collector();
    assert.equal(await main(['refresh', '--token-file', file], { fetchImpl: good.fetchImpl, log: okOut.log, error: okOut.log }), 0);
    assert.deepEqual(okOut.lines, ['refresh succeeded']);
    assert.equal(good.requests.filter((r) => r.url === `${ISSUER}/oauth/token`)[1].body.refresh_token, ROTATED_REFRESH);
    const revoker = fakeIssuer();
    await revokeGrant({ file }, { fetchImpl: revoker.fetchImpl });
    const revoked = revoker.requests.filter((r) => r.url === `${ISSUER}/oauth/revoke`);
    assert.deepEqual(revoked.map((r) => r.body.token), [ROTATED_REFRESH, ROTATED]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh on a CLI credential file keeps its other keys and moves expires_at', async () => {
  const dir = await tmp();
  try {
    await writeOAuthCredential(dir, {
      issuer: ISSUER, clientId: CLIENT_ID, resource: RESOURCE, email: 'a@example.test',
      accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 1,
    });
    const file = path.join(dir, 'token');
    assert.deepEqual(await tryRefresh({ file }, { fetchImpl: fakeIssuer().fetchImpl }), { refreshed: true });
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual([doc.kind, doc.email, doc.access_token, doc.refresh_token], ['oauth', 'a@example.test', ROTATED, ROTATED_REFRESH]);
    assert.ok(doc.expires_at > Date.now());
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh is "failed" only when the issuer refuses the grant, and says which OAuth error', async () => {
  const dir = await tmp();
  try {
    const file = await ownTokenFile(dir);
    const before = await readFile(file, 'utf8');
    const bad = fakeIssuer({ tokenStatus: 400 });
    assert.deepEqual(await tryRefresh({ file }, { fetchImpl: bad.fetchImpl }), { refreshed: false, code: 'invalid_grant' });
    const badOut = collector();
    assert.equal(await main(['refresh', '--token-file', file], { fetchImpl: bad.fetchImpl, log: badOut.log, error: badOut.log }), 1);
    assert.deepEqual(badOut.lines, ['refresh failed (invalid_grant)']);
    const other = collector();
    assert.equal(await main(['refresh', '--token-file', file], { fetchImpl: fakeIssuer({ tokenStatus: 401, tokenError: 'invalid_client' }).fetchImpl, log: other.log, error: other.log }), 1);
    assert.deepEqual(other.lines, ['refresh failed (invalid_client)']);
    assert.equal(await readFile(file, 'utf8'), before, 'a refused refresh leaves the file alone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh with a timeout, 5xx, 429, discovery error or failing fetch is an error (exit 2), never "refresh failed"', async () => {
  const dir = await tmp();
  try {
    const file = await ownTokenFile(dir);
    const before = await readFile(file, 'utf8');
    const issuer = fakeIssuer();
    const cases = [
      ['HTTP 500', fakeIssuer({ tokenStatus: 500, tokenError: null }).fetchImpl],
      ['(invalid_grant)', fakeIssuer({ tokenStatus: 500 }).fetchImpl],
      ['HTTP 429', fakeIssuer({ tokenStatus: 429, tokenError: null }).fetchImpl],
      ['(rate_limited)', fakeIssuer({ tokenStatus: 429, tokenError: 'rate_limited' }).fetchImpl],
      ['HTTP 408', fakeIssuer({ tokenStatus: 408, tokenError: null }).fetchImpl],
      ['could not reach', async (input, init) => {
        if (String(input).endsWith('/oauth/token')) throw new TypeError('fetch failed');
        return issuer.fetchImpl(input, init);
      }],
      ['could not reach', async () => { throw new TypeError('fetch failed'); }],
      ['HTTP 503', async (input, init) => (String(input).includes('.well-known') ? new Response(null, { status: 503 }) : issuer.fetchImpl(input, init))],
    ];
    for (const [expected, fetchImpl] of cases) {
      await assert.rejects(tryRefresh({ file }, { fetchImpl }), (e) => e instanceof UserError && e.message.includes(expected), expected);
      const output = collector();
      assert.equal(await main(['refresh', '--token-file', file], { fetchImpl, log: output.log, error: output.log }), 2, expected);
      assert.equal(output.lines.length, 1);
      assert.ok(output.lines[0].includes(expected), output.lines[0]);
      assert.doesNotMatch(output.lines[0], /refresh failed/);
      assert.ok(noSecrets(output.lines[0]));
    }
    assert.equal(await readFile(file, 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A fake clock: sleep advances it, a call takes no time.
function clock(start) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, advance: (ms) => { t += ms; }, sleeps,
  };
}

test('pacedSearch starts at the next minute boundary, never exceeds perSecond and reports the first rate_limited index', async () => {
  const fake = clock(5 * 60000 + 17250);
  const starts = [];
  const call = async (i) => {
    starts.push(fake.now());
    return i >= 60 ? 'rate_limited' : 'ok';
  };
  const {
    results, firstRateLimited, elapsedMs, withinWindow,
  } = await pacedSearch({ call, count: 61, perSecond: 4, sleep: fake.sleep, now: fake.now });
  assert.equal(fake.sleeps[0], 60000 - 17250);
  assert.equal(elapsedMs, 15000);
  assert.equal(withinWindow, true);
  assert.equal(starts[0] % 60000, 0);
  assert.equal(results.length, 61);
  assert.equal(results[59], 'ok');
  assert.equal(results[60], 'rate_limited');
  assert.equal(firstRateLimited, 60);
  for (const t of starts) assert.ok(starts.filter((s) => s > t - 1000 && s <= t).length <= 4);
  assert.ok(starts[60] - starts[0] < 60000, 'all 61 calls fit inside one minute window');
});

test('pacedSearch reports when the last call started after the next minute boundary', async () => {
  const fake = clock(3 * 60000 + 1000);
  const slow = async () => { fake.advance(35000); return 'ok'; };
  const { elapsedMs, withinWindow } = await pacedSearch({ call: slow, count: 3, perSecond: 4, sleep: fake.sleep, now: fake.now });
  assert.equal(withinWindow, false, 'the third call started 70 s into the window');
  assert.equal(elapsedMs, 105000);
});

test('pacedSearch with no rate limit reports null and does not wait on an exact boundary', async () => {
  const fake = clock(7 * 60000);
  const { results, firstRateLimited } = await pacedSearch({ call: async () => 'ok', count: 3, perSecond: 4, sleep: fake.sleep, now: fake.now });
  assert.deepEqual(results, ['ok', 'ok', 'ok']);
  assert.equal(firstRateLimited, null);
  assert.deepEqual(fake.sleeps, []);
});

test('paced-search prints per-call statuses and the first rate_limited index through main', async () => {
  const dir = await tmp();
  try {
    const file = await ownTokenFile(dir);
    const fake = clock(60000 + 59500);
    let n = 0;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: {} });
      n += 1;
      const limited = n > 3;
      return json({ jsonrpc: '2.0', id: body.id, result: limited
        ? { isError: true, structuredContent: { error: { code: 'rate_limited', retry_after: 5 } } }
        : { structuredContent: { results: [] } } });
    };
    const output = collector();
    const code = await main(['paced-search', '--url', RESOURCE, '--token-file', file, '--count', '5', '--per-second', '2'], {
      fetchImpl, log: output.log, error: output.log, sleep: fake.sleep, now: fake.now,
    });
    assert.equal(code, 0);
    assert.deepEqual(output.lines, [
      'index 0: ok', 'index 1: ok', 'index 2: ok', 'index 3: rate_limited', 'index 4: rate_limited',
      'first rate_limited: index 3',
      'elapsed: 2.0 s',
      'last call started before the next minute boundary: yes',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
