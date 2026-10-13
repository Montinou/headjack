import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCredential, writeOAuthCredential, withCredentialLock, freshCredential,
} from '../../cli/credentials.mjs';
import { UserError } from '../../lib/errors.mjs';

const ISSUER = 'https://auth.example.invalid';
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const RESOURCE = 'https://headjack.example.invalid/api';
const FIXTURE = fileURLToPath(new URL('../fixtures/cli-credentials-refresh.mjs', import.meta.url));

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sv-cli-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const oauthCredential = (over = {}) => ({
  kind: 'oauth',
  source: 'file',
  issuer: ISSUER,
  clientId: 'client_cli',
  resource: RESOURCE,
  email: 'user@example.invalid',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3600e3,
  ...over,
});

const storedJson = (over = {}) => ({
  kind: 'oauth',
  issuer: ISSUER,
  client_id: 'client_cli',
  resource: RESOURCE,
  email: 'user@example.invalid',
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_at: Date.now() + 3600e3,
  ...over,
});

async function writeToken(dir, content, mode = 0o600) {
  const file = path.join(dir, 'token');
  await writeFile(file, content);
  await chmod(file, mode);
  return file;
}

const isUserError = (message) => (e) => e instanceof UserError && e.message === message;
const invalid = (file) => `${file} is not a valid credential; run headjack login --force`;

// A fake authorization server behind a fetch fake: discovery documents plus a token endpoint that rotates on each
// refresh and refuses a refresh token that was already rotated away.
function fakeIssuer({ tokenStatus = 200 } = {}) {
  const refreshes = [];
  let current = 'refresh-1';
  let n = 1;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
      const body = Object.fromEntries(init.body);
      refreshes.push(body);
      if (tokenStatus !== 200) return json({ error: 'invalid_grant' }, tokenStatus);
      if (body.refresh_token !== current) return json({ error: 'invalid_grant' }, 400);
      n += 1;
      current = `refresh-${n}`;
      return json({ access_token: `access-${n}`, refresh_token: current, expires_in: 3600, token_type: 'Bearer' });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, refreshes };
}

const noNetwork = async (url) => { throw new Error(`unexpected request to ${url}`); };

test('no credential at all is null', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await readCredential({ env: {}, dir }), null);
});

test('an API key from the environment wins over the file', async (t) => {
  const dir = await tempDir(t);
  await writeToken(dir, JSON.stringify(storedJson()));
  assert.deepEqual(await readCredential({ env: { HEADJACK_TOKEN: 'ak_env' }, dir }), { kind: 'api-key', token: 'ak_env', source: 'env' });
});

test('a raw token file is an API key', async (t) => {
  const dir = await tempDir(t);
  await writeToken(dir, '  ak_file\n');
  assert.deepEqual(await readCredential({ env: {}, dir }), { kind: 'api-key', token: 'ak_file', source: 'file' });
});

test('an OAuth JSON file is parsed into the camelCase credential', async (t) => {
  const dir = await tempDir(t);
  const stored = storedJson({ expires_at: 1790000000000 });
  await writeToken(dir, `${JSON.stringify(stored)}\n`);
  assert.deepEqual(await readCredential({ env: {}, dir }), oauthCredential({ expiresAt: 1790000000000 }));
});

test('corrupt credential file is a user error', async (t) => {
  const dir = await tempDir(t);
  const { refresh_token: _dropped, ...noRefresh } = storedJson();
  const cases = [
    '',
    '  \n',
    '{"kind":"oauth","issuer":',
    JSON.stringify(storedJson({ kind: 'api-key' })),
    JSON.stringify({ ...storedJson(), kind: undefined }),
    JSON.stringify(noRefresh),
    JSON.stringify(storedJson({ access_token: '' })),
    JSON.stringify(storedJson({ expires_at: '1790000000000' })),
    JSON.stringify(storedJson({ email: null })),
    '{"kind":"oauth"} trailing',
  ];
  for (const content of cases) {
    const file = await writeToken(dir, content);
    await assert.rejects(readCredential({ env: {}, dir }), isUserError(invalid(file)), `content: ${content}`);
  }
});

test('a token file readable by others is refused with the chmod fix', async (t) => {
  const dir = await tempDir(t);
  const file = await writeToken(dir, 'ak_file\n', 0o640);
  await assert.rejects(readCredential({ env: {}, dir }), isUserError(`${file} has mode 640; run: chmod 600 ${file}`));
});

test('written file has mode 600 and no temp file remains', async (t) => {
  const dir = await tempDir(t);
  // An old world-readable file and a permissive umask must not leak into the written credential.
  await writeToken(dir, 'ak_old\n', 0o644);
  const previous = process.umask(0);
  try {
    await writeOAuthCredential(dir, oauthCredential({ expiresAt: 1790000000000 }));
  } finally {
    process.umask(previous);
  }
  const file = path.join(dir, 'token');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['token']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), storedJson({ expires_at: 1790000000000 }));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))),
    ['kind', 'issuer', 'client_id', 'resource', 'email', 'access_token', 'refresh_token', 'expires_at']);
});

test('the lock runs the function, returns its value and always removes the lock', async (t) => {
  const dir = await tempDir(t);
  const lock = path.join(dir, 'token.lock');
  assert.equal(await withCredentialLock(dir, async () => {
    await stat(lock);
    return 42;
  }), 42);
  await assert.rejects(stat(lock), { code: 'ENOENT' });
  await assert.rejects(withCredentialLock(dir, async () => { throw new Error('boom'); }), /boom/);
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

test('a held lock makes the caller wait, then gives up with a user error', async (t) => {
  const dir = await tempDir(t);
  const lock = path.join(dir, 'token.lock');
  await writeFile(lock, '1\n');
  let ran = false;
  const started = Date.now();
  await assert.rejects(
    withCredentialLock(dir, async () => { ran = true; }, { waitMs: 300 }),
    isUserError('another headjack process is refreshing the login'),
  );
  assert.equal(ran, false);
  assert.ok(Date.now() - started >= 300);
  // The other process's lock is not ours to remove.
  await stat(lock);
});

test('a lock released while waiting is taken', async (t) => {
  const dir = await tempDir(t);
  const lock = path.join(dir, 'token.lock');
  await writeFile(lock, '1\n');
  setTimeout(() => { rm(lock, { force: true }); }, 150);
  assert.equal(await withCredentialLock(dir, async () => 'ran', { waitMs: 5000 }), 'ran');
});

test('stale lock older than 30 s is taken over', async (t) => {
  const dir = await tempDir(t);
  const lock = path.join(dir, 'token.lock');
  await writeFile(lock, '1\n');
  const old = new Date(Date.now() - 31e3);
  await utimes(lock, old, old);
  assert.equal(await withCredentialLock(dir, async () => 'ran', { waitMs: 200 }), 'ran');
  await assert.rejects(stat(lock), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dir), []);
});

test('a lock younger than 30 s is not taken over', async (t) => {
  const dir = await tempDir(t);
  const lock = path.join(dir, 'token.lock');
  await writeFile(lock, '1\n');
  const recent = new Date(Date.now() - 20e3);
  await utimes(lock, recent, recent);
  await assert.rejects(withCredentialLock(dir, async () => 'ran', { waitMs: 200 }), isUserError('another headjack process is refreshing the login'));
});

test('a credential outside the refresh window is returned unchanged without the network', async (t) => {
  const dir = await tempDir(t);
  const credential = oauthCredential({ expiresAt: 1_000_000 + 61e3 });
  const result = await freshCredential({ dir, credential }, { fetchImpl: noNetwork, now: () => 1_000_000 });
  assert.equal(result, credential);
  assert.deepEqual(await readdir(dir), []);
});

test('a credential inside the refresh window is refreshed, stored and returned', async (t) => {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, oauthCredential({ expiresAt: Date.now() + 30e3 }));
  const credential = await readCredential({ env: {}, dir });
  const { fetchImpl, refreshes } = fakeIssuer();
  const before = Date.now();
  const result = await freshCredential({ dir, credential }, { fetchImpl });
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0], { grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client_cli', resource: RESOURCE });
  assert.equal(result.accessToken, 'access-2');
  assert.equal(result.refreshToken, 'refresh-2');
  assert.ok(result.expiresAt >= before + 3600e3);
  assert.deepEqual(result, { ...credential, accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: result.expiresAt });
  assert.deepEqual(await readCredential({ env: {}, dir }), result);
  assert.deepEqual(await readdir(dir), ['token']);
});

test('a rejected token forces a refresh even when the file is fresh', async (t) => {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, oauthCredential());
  const credential = await readCredential({ env: {}, dir });
  const { fetchImpl, refreshes } = fakeIssuer();
  const result = await freshCredential({ dir, credential, rejectedToken: 'access-1' }, { fetchImpl });
  assert.equal(refreshes.length, 1);
  assert.equal(result.accessToken, 'access-2');
  assert.equal((await readCredential({ env: {}, dir })).refreshToken, 'refresh-2');
});

test('a rejected token already replaced in the file is not refreshed again', async (t) => {
  const dir = await tempDir(t);
  const credential = oauthCredential();
  // Another process already refreshed after the same 401.
  await writeOAuthCredential(dir, oauthCredential({ accessToken: 'access-2', refreshToken: 'refresh-2' }));
  // Discovery runs before the lock; the token endpoint is never called.
  const { fetchImpl, refreshes } = fakeIssuer();
  const result = await freshCredential({ dir, credential, rejectedToken: 'access-1' }, { fetchImpl });
  assert.equal(refreshes.length, 0);
  assert.equal(result.accessToken, 'access-2');
  assert.equal(result.refreshToken, 'refresh-2');
});

test('the refresh uses the refresh token stored in the file, not the stale one in memory', async (t) => {
  const dir = await tempDir(t);
  const { fetchImpl, refreshes } = fakeIssuer();
  // The file holds a rotated refresh token whose access token is itself about to expire.
  await writeOAuthCredential(dir, oauthCredential({ refreshToken: 'refresh-1', accessToken: 'access-x', expiresAt: Date.now() + 10e3 }));
  const credential = oauthCredential({ refreshToken: 'refresh-0', accessToken: 'access-0', expiresAt: Date.now() - 1e3 });
  const result = await freshCredential({ dir, credential }, { fetchImpl });
  assert.equal(refreshes[0].refresh_token, 'refresh-1');
  assert.equal(result.accessToken, 'access-2');
});

test('refresh failure message', async (t) => {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, oauthCredential({ expiresAt: Date.now() - 1e3 }));
  const credential = await readCredential({ env: {}, dir });
  const before = await readFile(path.join(dir, 'token'), 'utf8');
  const { fetchImpl } = fakeIssuer({ tokenStatus: 400 });
  await assert.rejects(freshCredential({ dir, credential }, { fetchImpl }), isUserError('session expired: run headjack login'));
  assert.equal(await readFile(path.join(dir, 'token'), 'utf8'), before);
  assert.deepEqual(await readdir(dir), ['token']);
});

// Only the issuer rejecting the refresh token says "session expired"; a failing or unreachable issuer keeps its own line
// naming the token endpoint, and the stored login is left as it was.
test('a token endpoint that is down, slow or failing is not "session expired"', async (t) => {
  const cases = [
    ['5xx', (fetchImpl) => fetchImpl, { tokenStatus: 503 }, /refused the request \(invalid_grant\)/],
    ['transport failure', (fetchImpl) => async (url, init) => {
      if (String(url) === TOKEN_ENDPOINT) throw new TypeError('fetch failed');
      return fetchImpl(url, init);
    }, {}, /could not reach/],
    ['timeout', (fetchImpl) => (url, init) => (String(url) === TOKEN_ENDPOINT ? new Promise(() => {}) : fetchImpl(url, init)), {}, /did not answer/],
  ];
  for (const [name, wrap, issuerOptions, pattern] of cases) {
    const dir = await tempDir(t);
    await writeOAuthCredential(dir, oauthCredential({ expiresAt: Date.now() - 1e3 }));
    const credential = await readCredential({ env: {}, dir });
    const before = await readFile(path.join(dir, 'token'), 'utf8');
    const { fetchImpl } = fakeIssuer(issuerOptions);
    await assert.rejects(
      freshCredential({ dir, credential }, { fetchImpl: wrap(fetchImpl), timeoutMs: 200 }),
      (e) => e instanceof UserError && e.message.includes(TOKEN_ENDPOINT) && pattern.test(e.message)
        && !e.message.includes('session expired') && !e.message.includes('\n'),
      name,
    );
    assert.equal(await readFile(path.join(dir, 'token'), 'utf8'), before, name);
    assert.deepEqual(await readdir(dir), ['token'], name);
  }
});

test('a credential file removed or replaced meanwhile is not resurrected by a refresh', async (t) => {
  const dir = await tempDir(t);
  const credential = oauthCredential({ expiresAt: Date.now() - 1e3 });
  const { fetchImpl, refreshes } = fakeIssuer();
  await assert.rejects(freshCredential({ dir, credential }, { fetchImpl }), isUserError('session expired: run headjack login'));
  assert.deepEqual(await readdir(dir), []);
  await writeToken(dir, 'ak_file\n');
  await assert.rejects(freshCredential({ dir, credential }, { fetchImpl }), isUserError('session expired: run headjack login'));
  await writeOAuthCredential(dir, oauthCredential({ expiresAt: Date.now() - 1e3, resource: 'https://other.example.invalid/api' }));
  await assert.rejects(freshCredential({ dir, credential }, { fetchImpl }), isUserError('session expired: run headjack login'));
  assert.equal(refreshes.length, 0);
});

test('discovery that never answers fails within the bound and never holds the lock', { timeout: 5000 }, async (t) => {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, oauthCredential({ expiresAt: Date.now() - 1e3 }));
  const credential = await readCredential({ env: {}, dir });
  const before = await readFile(path.join(dir, 'token'), 'utf8');
  const requests = [];
  let discovering;
  const discoveryStarted = new Promise((resolve) => { discovering = resolve; });
  const fetchImpl = (url) => {
    requests.push(String(url));
    discovering();
    return new Promise(() => {});
  };
  const started = Date.now();
  const pending = freshCredential({ dir, credential }, { fetchImpl, timeoutMs: 200 });
  pending.catch(() => {});
  await discoveryStarted;
  // While discovery hangs, the lock is free: another process can take it at once.
  assert.equal(await withCredentialLock(dir, async () => 'free', { waitMs: 0 }), 'free');
  await assert.rejects(pending, (e) => e instanceof UserError && !e.message.includes('\n') && /did not answer/.test(e.message));
  assert.ok(Date.now() - started < 2000);
  assert.ok(requests.every((u) => u.includes('/.well-known/')), 'no token request');
  assert.equal(await readFile(path.join(dir, 'token'), 'utf8'), before);
  assert.deepEqual(await readdir(dir), ['token']);
});

test('a slow discovery does not hold the lock while another process refreshes, and no second refresh follows', async (t) => {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, oauthCredential({ expiresAt: Date.now() - 1e3 }));
  const credential = await readCredential({ env: {}, dir });
  const { fetchImpl, refreshes } = fakeIssuer();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowDiscovery = async (url, init) => {
    if (String(url).includes('/.well-known/')) await gate;
    return fetchImpl(url, init);
  };
  const slow = freshCredential({ dir, credential }, { fetchImpl: slowDiscovery });
  // The other process refreshes while the first is still discovering; a held lock would make it wait.
  const other = await freshCredential({ dir, credential }, { fetchImpl });
  assert.equal(other.accessToken, 'access-2');
  release();
  const result = await slow;
  assert.equal(result.accessToken, 'access-2');
  assert.equal(refreshes.length, 1);
  assert.equal((await readCredential({ env: {}, dir })).refreshToken, 'refresh-2');
});

test('a refreshed login that cannot be saved is a one-line user error naming the file', async (t) => {
  const dir = await tempDir(t);
  await writeOAuthCredential(dir, oauthCredential({ expiresAt: Date.now() - 1e3 }));
  const credential = await readCredential({ env: {}, dir });
  const { fetchImpl } = fakeIssuer();
  const file = path.join(dir, 'token');
  // The directory turns read-only once the refresh is under way, so the rotated tokens cannot be written.
  const failingSave = async (url, init) => {
    if (String(url) === TOKEN_ENDPOINT) await chmod(dir, 0o500);
    return fetchImpl(url, init);
  };
  try {
    await assert.rejects(
      freshCredential({ dir, credential }, { fetchImpl: failingSave }),
      isUserError(`could not save the refreshed login to ${file}; run headjack login`),
    );
  } finally {
    await chmod(dir, 0o700);
  }
});

// A real token endpoint on loopback shared by two processes: it rotates the refresh token on every refresh and answers
// slowly, so a contender that did not wait for the lock would refresh with the rotated-away token.
async function startRotatingIssuer(t) {
  const state = { refreshes: [], current: 'refresh-1', n: 1 };
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const issuer = `http://127.0.0.1:${server.address().port}`;
    if (req.method === 'GET' && req.url === '/.well-known/oauth-authorization-server') {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        revocation_endpoint: `${issuer}/oauth/token/revoke`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (req.method === 'GET' && req.url === '/.well-known/openid-configuration') return send(200, { issuer, userinfo_endpoint: `${issuer}/oauth/userinfo` });
    if (req.method === 'POST' && req.url === '/oauth/token') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = Object.fromEntries(new URLSearchParams(raw));
        state.refreshes.push(body);
        setTimeout(() => {
          if (body.refresh_token !== state.current) return send(400, { error: 'invalid_grant' });
          state.n += 1;
          state.current = `refresh-${state.n}`;
          send(200, { access_token: `access-${state.n}`, refresh_token: state.current, expires_in: 3600, token_type: 'Bearer' });
        }, 300);
      });
      return undefined;
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { issuer: `http://127.0.0.1:${server.address().port}`, state };
}

function startContender(dir) {
  const child = spawn(process.execPath, [FIXTURE, dir], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.startsWith('ready\n')) resolve();
    });
    child.on('exit', () => reject(new Error(`contender exited before ready: ${err}`)));
  });
  const done = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, out, err }));
  });
  child.stderr.on('data', (chunk) => { err += chunk; });
  return { child, ready, done };
}

test('concurrent refresh keeps the rotated token', async (t) => {
  const dir = await tempDir(t);
  const { issuer, state } = await startRotatingIssuer(t);
  await writeOAuthCredential(dir, oauthCredential({ issuer, expiresAt: Date.now() - 1e3 }));
  const contenders = [startContender(dir), startContender(dir)];
  await Promise.all(contenders.map((c) => c.ready));
  for (const c of contenders) c.child.stdin.end('go\n');
  const results = await Promise.all(contenders.map((c) => c.done));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(state.refreshes.length, 1);
  assert.equal(state.refreshes[0].refresh_token, 'refresh-1');
  const tokens = results.map((r) => JSON.parse(r.out.split('\n')[1]).accessToken);
  assert.deepEqual(tokens, ['access-2', 'access-2']);
  const stored = JSON.parse(await readFile(path.join(dir, 'token'), 'utf8'));
  assert.equal(stored.refresh_token, 'refresh-2');
  assert.equal(stored.access_token, 'access-2');
  assert.deepEqual(await readdir(dir), ['token']);
});
