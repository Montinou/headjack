import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fsp, { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { login, logout, whoami } from '../../cli/login.mjs';
import { loadUrl } from '../../cli/config.mjs';
import { withCredentialLock } from '../../cli/credentials.mjs';
import { UserError } from '../../lib/errors.mjs';
import { ISSUER_TOKENS, startHeadjack, startIssuer } from '../fixtures/fake-oauth-servers.mjs';


async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sv-cli-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Starts both fakes and closes them when the test ends.
async function servers(t, issuerOptions, headjackOptions) {
  const issuer = await startIssuer(issuerOptions);
  const headjack = await startHeadjack({ issuer: issuer.origin, ...headjackOptions });
  t.after(async () => { await Promise.all([issuer.close(), headjack.close()]); });
  return { issuer, headjack };
}

// A port nobody listens on right now (ephemeral, never the CLI's real callback ports).
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function occupy(t, port) {
  return new Promise((resolve) => {
    const blocker = createServer();
    blocker.listen(port, '127.0.0.1', () => {
      t.after(() => new Promise((done) => { blocker.close(done); }));
      resolve(blocker);
    });
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// The browser: opens the authorization URL by performing the callback GET the issuer's redirect would cause. `tamper`
// edits the callback query ((params, authorizeUrl) => void); `before` runs before the real callback.
function browser({ tamper, before } = {}) {
  const opened = [];
  const openUrl = async (url) => {
    opened.push(url);
    const authorize = new URL(url);
    const callback = new URL(authorize.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'code-1');
    callback.searchParams.set('state', authorize.searchParams.get('state'));
    tamper?.(callback.searchParams, authorize);
    await before?.(callback);
    await fetch(callback);
  };
  openUrl.opened = opened;
  return openUrl;
}

// Resolves once the code under test is polling a held lock: withCredentialLock stat()s token.lock only while it waits for it,
// so this is the observable proof that the caller reached the lock and is blocked there (no fixed sleep).
function lockWaiter(t, dir) {
  const lock = path.join(dir, 'token.lock');
  const original = fsp.stat;
  let blockedOn;
  const blocked = new Promise((resolve) => { blockedOn = resolve; });
  fsp.stat = async (target, ...rest) => {
    if (target === lock) blockedOn();
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.stat = original; syncBuiltinESMExports(); });
  return blocked;
}

// [hint, token] of every revocation the issuer saw, in order.
const revoked = (issuer) => issuer.requests.filter((r) => r.path === '/oauth/revoke').map((r) => [r.body.token_type_hint, r.body.token]);
const MINTED_PAIR = [['refresh_token', ISSUER_TOKENS.refreshToken], ['access_token', ISSUER_TOKENS.accessToken]];

const never = () => { throw new Error('the browser must not be opened'); };
const isUserError = (message) => (e) => e instanceof UserError && e.message === message;
const tokenFile = (dir) => path.join(dir, 'token');

const storedOAuth = (issuer, over = {}) => ({
  kind: 'oauth',
  issuer,
  client_id: 'client_cli',
  resource: 'http://127.0.0.1:1/api',
  email: 'old@example.invalid',
  access_token: 'at-old',
  refresh_token: 'rt-old',
  expires_at: Date.now() + 3600e3,
  ...over,
});

async function writeToken(dir, content, mode = 0o600) {
  await writeFile(tokenFile(dir), content);
  await chmod(tokenFile(dir), mode);
}

// A login run with the common wiring; returns what login returned plus what the fakes saw.
async function runLogin(t, { issuerOptions, headjackOptions, browserOptions, env = {}, force = false, loginOptions = {} } = {}) {
  const dir = await tempDir(t);
  const { issuer, headjack } = await servers(t, issuerOptions, headjackOptions);
  const port = await freePort();
  const openUrl = browser(browserOptions);
  const logs = [];
  const run = () => login({ url: headjack.origin, dir, force, env }, { openUrl, ports: [port], log: (m) => logs.push(m), ...loginOptions });
  return { dir, issuer, headjack, port, openUrl, logs, run };
}

test('a successful login writes a 600 credential with the email, after a PKCE code exchange', async (t) => {
  const ctx = await runLogin(t);
  const result = await ctx.run();
  assert.deepEqual(result, { email: 'ana@example.invalid' });

  const st = await stat(tokenFile(ctx.dir));
  assert.equal(st.mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8'));
  assert.equal(saved.kind, 'oauth');
  assert.equal(saved.issuer, ctx.issuer.origin);
  assert.equal(saved.client_id, 'client_cli');
  assert.equal(saved.resource, `${ctx.headjack.origin}/api`);
  assert.equal(saved.email, 'ana@example.invalid');
  assert.equal(saved.access_token, ISSUER_TOKENS.accessToken);
  assert.equal(saved.refresh_token, ISSUER_TOKENS.refreshToken);
  assert.ok(saved.expires_at > Date.now());

  // The authorization URL carries every parameter of the spec, with a 32-byte base64url state.
  assert.equal(ctx.openUrl.opened.length, 1);
  const authorize = new URL(ctx.openUrl.opened[0]);
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${ctx.issuer.origin}/oauth/authorize`);
  const q = authorize.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), 'client_cli');
  assert.equal(q.get('redirect_uri'), `http://127.0.0.1:${ctx.port}/callback`);
  assert.equal(q.get('scope'), 'openid email offline_access skills:read skills:write');
  assert.equal(q.get('resource'), `${ctx.headjack.origin}/api`);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(ctx.logs.some((line) => line.includes(ctx.openUrl.opened[0])), 'the URL is always printed');

  // The code is exchanged with the verifier that matches the challenge, at the redirect the server was listening on.
  const exchange = ctx.issuer.requests.find((r) => r.path === '/oauth/token');
  assert.equal(exchange.body.grant_type, 'authorization_code');
  assert.equal(exchange.body.code, 'code-1');
  assert.equal(exchange.body.client_id, 'client_cli');
  assert.equal(exchange.body.redirect_uri, `http://127.0.0.1:${ctx.port}/callback`);
  assert.equal(exchange.body.resource, `${ctx.headjack.origin}/api`);
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), q.get('code_challenge'));

  const userinfo = ctx.issuer.requests.find((r) => r.path === '/oauth/userinfo');
  assert.equal(userinfo.headers.authorization, `Bearer ${ISSUER_TOKENS.accessToken}`);

  assert.equal(await canListen(ctx.port), true, 'the callback server is closed');
  assert.equal(JSON.stringify(ctx.logs).includes(ISSUER_TOKENS.accessToken), false);
  assert.equal(JSON.stringify(ctx.logs).includes(ISSUER_TOKENS.refreshToken), false);
});

test('login works with no credential file and a matching iss', async (t) => {
  const ctx = await runLogin(t, { browserOptions: { tamper: (params) => params.set('iss', ctx.issuer.origin) } });
  await assert.rejects(stat(tokenFile(ctx.dir)), { code: 'ENOENT' });
  assert.deepEqual(await ctx.run(), { email: 'ana@example.invalid' });
});

test('a forged callback with a wrong or missing state is answered 400 and does not end the login', async (t) => {
  const answered = [];
  const ctx = await runLogin(t, {
    browserOptions: {
      before: async (callback) => {
        const base = `http://127.0.0.1:${callback.port}/callback`;
        for (const query of ['code=evil&state=forged', 'code=evil', 'error=access_denied', 'error=access_denied&state=forged']) {
          answered.push((await fetch(`${base}?${query}`)).status);
        }
      },
    },
  });
  assert.deepEqual(await ctx.run(), { email: 'ana@example.invalid' });
  assert.deepEqual(answered, [400, 400, 400, 400]);
  const exchanges = ctx.issuer.requests.filter((r) => r.path === '/oauth/token');
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].body.code, 'code-1', 'only the callback with the real state is exchanged');
  assert.equal(await canListen(ctx.port), true);
});

test('a request target that does not parse is a 404 and does not end the login', async (t) => {
  const answered = [];
  const ctx = await runLogin(t, {
    browserOptions: {
      before: async (callback) => {
        // `GET // HTTP/1.1`: new URL('//', base) throws, which used to kill the CLI with a stack trace.
        answered.push((await fetch(`http://127.0.0.1:${callback.port}//`)).status);
        answered.push((await fetch(`http://127.0.0.1:${callback.port}///callback?state=x`)).status);
      },
    },
  });
  assert.deepEqual(await ctx.run(), { email: 'ana@example.invalid' });
  assert.deepEqual(answered, [404, 404]);
});

test('iss mismatch is refused', async (t) => {
  const ctx = await runLogin(t, { browserOptions: { tamper: (params) => params.set('iss', 'https://evil.example.invalid') } });
  await assert.rejects(ctx.run(), (e) => e instanceof UserError && /issuer/.test(e.message) && !e.message.includes('\n'));
  assert.equal(ctx.issuer.requests.some((r) => r.path === '/oauth/token'), false);
  await assert.rejects(stat(tokenFile(ctx.dir)), { code: 'ENOENT' });
  assert.equal(await canListen(ctx.port), true);
});

test('denied consent exits cleanly', async (t) => {
  const ctx = await runLogin(t, {
    browserOptions: { tamper: (params) => { params.delete('code'); params.set('error', 'access_denied'); } },
  });
  await assert.rejects(ctx.run(), isUserError('login was not approved'));
  await assert.rejects(stat(tokenFile(ctx.dir)), { code: 'ENOENT' });
  assert.equal(await canListen(ctx.port), true, 'the port is free afterwards');
});

test('a callback without a code is refused', async (t) => {
  const ctx = await runLogin(t, { browserOptions: { tamper: (params) => params.delete('code') } });
  await assert.rejects(ctx.run(), (e) => e instanceof UserError && /code/.test(e.message));
});

test('login times out after the callback window and releases the port', async (t) => {
  const ctx = await runLogin(t, { loginOptions: { timeoutMs: 50, openUrl: async () => {} } });
  await assert.rejects(ctx.run(), isUserError('login timed out after 5 minutes'));
  assert.equal(await canListen(ctx.port), true);
  await assert.rejects(stat(tokenFile(ctx.dir)), { code: 'ENOENT' });
});

test('a busy first port falls through to the next one', async (t) => {
  const ctx = await runLogin(t);
  const busy = await freePort();
  await occupy(t, busy);
  const result = await login({ url: ctx.headjack.origin, dir: ctx.dir }, { openUrl: ctx.openUrl, ports: [busy, ctx.port], log: () => {} });
  assert.equal(result.email, 'ana@example.invalid');
  const redirect = new URL(new URL(ctx.openUrl.opened[0]).searchParams.get('redirect_uri'));
  assert.equal(redirect.port, String(ctx.port));
});

test('all ports busy is a user error naming them', async (t) => {
  const ctx = await runLogin(t);
  const a = await freePort();
  const b = await freePort();
  await occupy(t, a);
  await occupy(t, b);
  await assert.rejects(
    login({ url: ctx.headjack.origin, dir: ctx.dir }, { openUrl: never, ports: [a, b], log: () => {} }),
    isUserError(`callback ports ${a}, ${b} are busy`),
  );
});

test('a listen failure other than a busy port is a one-line user error naming the port', async (t) => {
  const ctx = await runLogin(t);
  await assert.rejects(
    login({ url: ctx.headjack.origin, dir: ctx.dir }, { openUrl: never, ports: [70000], log: () => {} }),
    (e) => e instanceof UserError && e.message.startsWith('could not listen on 127.0.0.1:70000') && !e.message.includes('\n'),
  );
});

test('stray requests do not consume the attempt', async (t) => {
  const stray = [];
  const ctx = await runLogin(t, {
    browserOptions: {
      before: async (callback) => {
        const base = `http://127.0.0.1:${callback.port}`;
        stray.push((await fetch(`${base}/favicon.ico`)).status);
        stray.push((await fetch(`${base}/callback`, { method: 'POST' })).status);
        stray.push((await fetch(`${base}/`)).status);
      },
    },
  });
  assert.deepEqual(await ctx.run(), { email: 'ana@example.invalid' });
  assert.deepEqual(stray, [404, 404, 404]);
});

test('an existing OAuth credential is kept without --force', async (t) => {
  const ctx = await runLogin(t);
  await writeToken(ctx.dir, JSON.stringify(storedOAuth(ctx.issuer.origin)));
  const before = await readFile(tokenFile(ctx.dir), 'utf8');
  await assert.rejects(
    login({ url: ctx.headjack.origin, dir: ctx.dir }, { openUrl: never, ports: [ctx.port], log: () => {} }),
    isUserError('already logged in as old@example.invalid: use --force to log in again'),
  );
  assert.equal(await readFile(tokenFile(ctx.dir), 'utf8'), before);
});

test('an API-key file is replaced only with --force', async (t) => {
  const ctx = await runLogin(t, { force: true });
  await writeToken(ctx.dir, 'api-key-value\n');
  await assert.rejects(
    login({ url: ctx.headjack.origin, dir: ctx.dir }, { openUrl: never, ports: [ctx.port], log: () => {} }),
    isUserError('the token file holds an API key: use --force to replace it'),
  );
  assert.equal(await readFile(tokenFile(ctx.dir), 'utf8'), 'api-key-value\n');
  assert.deepEqual(await ctx.run(), { email: 'ana@example.invalid' });
  assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).kind, 'oauth');
  assert.equal((await stat(tokenFile(ctx.dir))).mode & 0o777, 0o600);
});

test('--force replaces an OAuth credential and repairs a corrupt file', async (t) => {
  const ctx = await runLogin(t, { force: true });
  await writeToken(ctx.dir, JSON.stringify(storedOAuth(ctx.issuer.origin)));
  await ctx.run();
  assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).email, 'ana@example.invalid');
  await writeToken(ctx.dir, '{ not json');
  await ctx.run();
  assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).access_token, ISSUER_TOKENS.accessToken);
});

test('an HEADJACK_TOKEN in the environment is not mistaken for an API-key file, but is warned about', async (t) => {
  const ctx = await runLogin(t, { env: { HEADJACK_TOKEN: 'env-api-key-value' } });
  assert.deepEqual(await ctx.run(), { email: 'ana@example.invalid' });
  const warning = ctx.logs.find((line) => /HEADJACK_TOKEN/.test(line));
  assert.ok(warning, 'a warning names HEADJACK_TOKEN');
  assert.match(warning, /overrid/);
  assert.equal(warning.includes('env-api-key-value'), false);
  const quiet = await runLogin(t);
  await quiet.run();
  assert.equal(quiet.logs.some((line) => /HEADJACK_TOKEN/.test(line)), false);
});

test('login writes the credential inside the credential lock', async (t) => {
  const ctx = await runLogin(t);
  const blocked = lockWaiter(t, ctx.dir);
  let during;
  let pending;
  await withCredentialLock(ctx.dir, async () => {
    pending = ctx.run();
    // The login got through the exchange and the vault check and is now waiting for the lock we hold.
    await Promise.race([blocked, pending.then(() => { throw new Error('the login finished while the lock was held'); })]);
    during = await stat(tokenFile(ctx.dir)).catch((e) => e.code);
  });
  assert.equal(during, 'ENOENT', 'nothing is written while another process holds the lock');
  assert.deepEqual(await pending, { email: 'ana@example.invalid' });
  assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).kind, 'oauth');
});

test('a login that fails after the exchange leaves the credential file alone, and revokes what it minted', async (t) => {
  for (const [name, options, minted] of [
    ['userinfo failure', { issuerOptions: { userinfoStatus: 500 } }, true],
    ['vault check failure', { headjackOptions: { updatesStatus: 503 } }, true],
    ['token endpoint refusal', { issuerOptions: { tokenStatus: 400 } }, false],
  ]) {
    const ctx = await runLogin(t, { ...options, force: true });
    await writeToken(ctx.dir, 'api-key-value\n');
    await assert.rejects(ctx.run(), (e) => e instanceof UserError && !e.message.includes('\n'), name);
    assert.equal(await readFile(tokenFile(ctx.dir), 'utf8'), 'api-key-value\n', name);
    assert.equal(await canListen(ctx.port), true, name);
    assert.deepEqual(revoked(ctx.issuer), minted ? MINTED_PAIR : [], name);
  }
});

test('a login refused under the lock revokes the pair it minted', async (t) => {
  const ctx = await runLogin(t, {
    // Another login lands while this one waits for the browser.
    browserOptions: { before: async () => { await writeToken(ctx.dir, JSON.stringify(storedOAuth(ctx.issuer.origin))); } },
  });
  const before = JSON.stringify(storedOAuth(ctx.issuer.origin));
  await assert.rejects(ctx.run(), isUserError('already logged in as old@example.invalid: use --force to log in again'));
  assert.equal((await readFile(tokenFile(ctx.dir), 'utf8')).replace(/"expires_at":\d+/, ''), before.replace(/"expires_at":\d+/, ''));
  assert.deepEqual(revoked(ctx.issuer), MINTED_PAIR);
});

test('a credential that cannot be saved is a one-line user error naming the file, and the minted pair is revoked', async (t) => {
  const ctx = await runLogin(t, {
    // The token path becomes a directory: the write under the lock fails with a plain fs error.
    browserOptions: { before: async () => { await mkdir(tokenFile(ctx.dir), { mode: 0o700 }); } },
  });
  await assert.rejects(
    ctx.run(),
    (e) => e instanceof UserError && e.message.startsWith(`could not save the login to ${tokenFile(ctx.dir)} (`) && !e.message.includes('\n'),
  );
  assert.deepEqual(revoked(ctx.issuer), MINTED_PAIR);
});

test('a failing revocation never hides the error that caused it', async (t) => {
  const ctx = await runLogin(t, { issuerOptions: { userinfoStatus: 500, revokeStatus: 500 } });
  await assert.rejects(ctx.run(), (e) => e instanceof UserError && /oauth\/userinfo/.test(e.message));
  assert.deepEqual(revoked(ctx.issuer), MINTED_PAIR);
});

test('--force over a login of the same issuer and client does not revoke it: the issuer may treat both as one grant', async (t) => {
  const ctx = await runLogin(t, { force: true });
  await writeToken(ctx.dir, JSON.stringify(storedOAuth(ctx.issuer.origin)));
  await ctx.run();
  assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).access_token, ISSUER_TOKENS.accessToken);
  assert.deepEqual(revoked(ctx.issuer), []);
  assert.equal(ctx.logs.some((line) => /could not be read/.test(line)), false);
});

test('--force over a login of another client revokes the old pair (refresh, then access) after the new one is saved', async (t) => {
  const ctx = await runLogin(t, { force: true });
  await writeToken(ctx.dir, JSON.stringify(storedOAuth(ctx.issuer.origin, { client_id: 'client_old' })));
  await ctx.run();
  assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).access_token, ISSUER_TOKENS.accessToken);
  const revocations = ctx.issuer.requests.filter((r) => r.path === '/oauth/revoke');
  assert.deepEqual(revocations.map((r) => [r.body.token_type_hint, r.body.token, r.body.client_id]), [
    ['refresh_token', 'rt-old', 'client_old'], ['access_token', 'at-old', 'client_old'],
  ]);
});

test('--force over a login of another issuer revokes the old pair at the old issuer only', async (t) => {
  const ctx = await runLogin(t, { force: true });
  const oldIssuer = await startIssuer();
  t.after(() => oldIssuer.close());
  await writeToken(ctx.dir, JSON.stringify(storedOAuth(oldIssuer.origin)));
  await ctx.run();
  assert.deepEqual(revoked(oldIssuer), [['refresh_token', 'rt-old'], ['access_token', 'at-old']]);
  assert.deepEqual(revoked(ctx.issuer), []);
});

test('--force over a file that cannot be read revokes nothing and says so', async (t) => {
  for (const [name, write] of [
    ['corrupt', (dir) => writeToken(dir, '{ not json')],
    ['loose mode', (dir, issuer) => writeToken(dir, JSON.stringify(storedOAuth(issuer)), 0o644)],
  ]) {
    const ctx = await runLogin(t, { force: true });
    await write(ctx.dir, ctx.issuer.origin);
    await ctx.run();
    assert.deepEqual(revoked(ctx.issuer), [], name);
    assert.deepEqual(ctx.logs.filter((line) => /could not be read/.test(line)), ['the previous login could not be read, so it was not revoked'], name);
    assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).access_token, ISSUER_TOKENS.accessToken, name);
  }
  const absent = await runLogin(t, { force: true });
  await absent.run();
  assert.equal(absent.logs.some((line) => /could not be read/.test(line)), false);
});

test('a trailing slash on the server URL logs in against the same server', async (t) => {
  const ctx = await runLogin(t);
  const result = await login({ url: loadUrl({ HEADJACK_URL: `${ctx.headjack.origin}//` }), dir: ctx.dir, env: {} }, { openUrl: ctx.openUrl, ports: [ctx.port], log: () => {} });
  assert.deepEqual(result, { email: 'ana@example.invalid' });
  assert.equal(JSON.parse(await readFile(tokenFile(ctx.dir), 'utf8')).resource, `${ctx.headjack.origin}/api`);
});

test('--force over an API key or a corrupt file revokes nothing, and a failed revocation of the old pair does not fail the login', async (t) => {
  const key = await runLogin(t, { force: true });
  await writeToken(key.dir, 'api-key-value\n');
  await key.run();
  assert.deepEqual(revoked(key.issuer), []);
  const corrupt = await runLogin(t, { force: true });
  await writeToken(corrupt.dir, '{ not json');
  await corrupt.run();
  assert.deepEqual(revoked(corrupt.issuer), []);
  const failing = await runLogin(t, { force: true, issuerOptions: { revokeStatus: 500 } });
  await writeToken(failing.dir, JSON.stringify(storedOAuth(failing.issuer.origin)));
  assert.deepEqual(await failing.run(), { email: 'ana@example.invalid' });
  assert.equal(JSON.parse(await readFile(tokenFile(failing.dir), 'utf8')).access_token, ISSUER_TOKENS.accessToken);
});

test('a server without CLI login stops before the browser opens', async (t) => {
  const ctx = await runLogin(t, { headjackOptions: { discovery: false } });
  await assert.rejects(
    login({ url: ctx.headjack.origin, dir: ctx.dir }, { openUrl: never, ports: [ctx.port], log: () => {} }),
    isUserError('this server has not enabled CLI login'),
  );
});

// --- logout ---

async function loggedIn(t, issuerOptions) {
  const dir = await tempDir(t);
  const issuer = await startIssuer(issuerOptions);
  t.after(() => issuer.close());
  await writeToken(dir, JSON.stringify(storedOAuth(issuer.origin)));
  return { dir, issuer };
}

test('logout revokes the refresh token, then the access token, and deletes the file', async (t) => {
  const { dir, issuer } = await loggedIn(t);
  assert.deepEqual(await logout({ dir }, {}), { revoked: true });
  const revocations = issuer.requests.filter((r) => r.path === '/oauth/revoke');
  assert.deepEqual(revocations.map((r) => [r.body.token_type_hint, r.body.token]), [['refresh_token', 'rt-old'], ['access_token', 'at-old']]);
  assert.ok(revocations.every((r) => r.body.client_id === 'client_cli'));
  await assert.rejects(stat(tokenFile(dir)), { code: 'ENOENT' });
});

test('logout deletes the file when revocation fails', async (t) => {
  const { dir } = await loggedIn(t, { revokeStatus: 500 });
  assert.deepEqual(await logout({ dir }, {}), { revoked: false });
  await assert.rejects(stat(tokenFile(dir)), { code: 'ENOENT' });
});

test('logout deletes the file when the issuer cannot be reached at all', async (t) => {
  const dir = await tempDir(t);
  const dead = await freePort();
  await writeToken(dir, JSON.stringify(storedOAuth(`http://127.0.0.1:${dead}`)));
  assert.deepEqual(await logout({ dir }, {}), { revoked: false });
  await assert.rejects(stat(tokenFile(dir)), { code: 'ENOENT' });
});

test('logout with an API key leaves the file in place', async (t) => {
  const dir = await tempDir(t);
  await writeToken(dir, 'api-key-value\n');
  await assert.rejects(logout({ dir }, {}), isUserError('API keys are revoked on the server; the token file was left in place'));
  assert.equal(await readFile(tokenFile(dir), 'utf8'), 'api-key-value\n');
});

test('logout with no credential says not logged in, and ignores HEADJACK_TOKEN', async (t) => {
  const dir = await tempDir(t);
  const saved = process.env.HEADJACK_TOKEN;
  process.env.HEADJACK_TOKEN = 'env-api-key-value';
  t.after(() => { if (saved === undefined) delete process.env.HEADJACK_TOKEN; else process.env.HEADJACK_TOKEN = saved; });
  await assert.rejects(logout({ dir }, {}), isUserError('not logged in'));
});

test('logout removes the file inside the credential lock', async (t) => {
  const { dir } = await loggedIn(t);
  const blocked = lockWaiter(t, dir);
  let during;
  let pending;
  await withCredentialLock(dir, async () => {
    pending = logout({ dir }, {});
    // logout is now polling the lock we hold.
    await Promise.race([blocked, pending.then(() => { throw new Error('logout finished while the lock was held'); })]);
    during = await stat(tokenFile(dir)).then(() => 'present', (e) => e.code);
  });
  assert.equal(during, 'present', 'the file survives while another process holds the lock');
  assert.deepEqual(await pending, { revoked: true });
  await assert.rejects(stat(tokenFile(dir)), { code: 'ENOENT' });
});

test('logout revokes what the file holds under the lock, not what it held before', async (t) => {
  const { dir, issuer } = await loggedIn(t);
  const blocked = lockWaiter(t, dir);
  let pending;
  await withCredentialLock(dir, async () => {
    pending = logout({ dir }, {});
    await Promise.race([blocked, pending.then(() => { throw new Error('logout finished while the lock was held'); })]);
    // A refresh in another process rotates the tokens while logout waits for the lock.
    await writeToken(dir, JSON.stringify(storedOAuth(issuer.origin, { access_token: 'at-rotated', refresh_token: 'rt-rotated' })));
  });
  assert.deepEqual(await pending, { revoked: true });
  const revoked = issuer.requests.filter((r) => r.path === '/oauth/revoke').map((r) => r.body.token);
  assert.deepEqual(revoked, ['rt-rotated', 'at-rotated']);
});

test('a token file that cannot be removed is a one-line user error naming it', async (t) => {
  const dir = await tempDir(t);
  const issuer = await startIssuer();
  t.after(() => issuer.close());
  await writeToken(dir, JSON.stringify(storedOAuth(issuer.origin)));
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  // A read-only directory: the lock cannot be created, so nothing is removed.
  await chmod(dir, 0o500);
  try {
    await assert.rejects(
      logout({ dir }, {}),
      (e) => e instanceof UserError && e.message.startsWith(`could not remove ${tokenFile(dir)} (`) && !e.message.includes('\n'),
    );
  } finally {
    await chmod(dir, 0o700);
  }
  assert.deepEqual(revoked(issuer), [], 'the login is still on disk, so its tokens are not revoked');
  assert.equal(JSON.parse(await readFile(tokenFile(dir), 'utf8')).kind, 'oauth');
});

// --- whoami ---

test('whoami reports an OAuth login with its email, expiry and the vault status, and no token', async (t) => {
  const dir = await tempDir(t);
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin, accepted: new Set(['at-who']) });
  t.after(async () => { await Promise.all([issuer.close(), headjack.close()]); });
  const expiresAt = Date.now() + 3600e3;
  await writeToken(dir, JSON.stringify(storedOAuth(issuer.origin, {
    resource: `${headjack.origin}/api`, email: 'who@example.invalid', access_token: 'at-who', refresh_token: 'rt-who', expires_at: expiresAt,
  })));
  const result = await whoami({ url: headjack.origin, dir, env: {} }, {});
  assert.deepEqual(result, { kind: 'oauth', source: 'file', email: 'who@example.invalid', expiresAt, status: 200 });
  assert.equal(JSON.stringify(result).includes('at-who'), false);
  assert.equal(JSON.stringify(result).includes('rt-who'), false);
});

test('whoami accepts the login of the same server spelled with a trailing slash', async (t) => {
  const dir = await tempDir(t);
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin });
  t.after(async () => { await Promise.all([issuer.close(), headjack.close()]); });
  await writeToken(dir, JSON.stringify(storedOAuth(issuer.origin, { resource: `${headjack.origin}/api/` })));
  assert.equal((await whoami({ url: loadUrl({ HEADJACK_URL: `${headjack.origin}/` }), dir, env: {} }, {})).status, 200);
});

test('whoami reports an API key from the file and from the environment, which wins', async (t) => {
  const dir = await tempDir(t);
  const headjack = await startHeadjack({ issuer: 'http://127.0.0.1:1', accepted: new Set(['file-key', 'env-key']) });
  t.after(() => headjack.close());
  await writeToken(dir, 'file-key\n');
  const fromFile = await whoami({ url: headjack.origin, dir, env: {} }, {});
  assert.deepEqual(fromFile, { kind: 'api-key', source: 'file', status: 200 });
  const fromEnv = await whoami({ url: headjack.origin, dir, env: { HEADJACK_TOKEN: 'env-key' } }, {});
  assert.deepEqual(fromEnv, { kind: 'api-key', source: 'env', status: 200 });
  const bearers = headjack.requests.filter((r) => r.path === '/api/updates').map((r) => r.headers.authorization);
  assert.deepEqual(bearers, ['Bearer file-key', 'Bearer env-key']);
});

test('whoami reports the status the vault answers, even a rejection', async (t) => {
  const dir = await tempDir(t);
  const headjack = await startHeadjack({ issuer: 'http://127.0.0.1:1', accepted: new Set(['other']) });
  t.after(() => headjack.close());
  const result = await whoami({ url: headjack.origin, dir, env: { HEADJACK_TOKEN: 'rejected' } }, {});
  assert.deepEqual(result, { kind: 'api-key', source: 'env', status: 401 });
});

test('whoami with no credential says not logged in', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(whoami({ url: 'http://127.0.0.1:1', dir, env: {} }, {}), isUserError('not logged in'));
});

test('whoami refuses a login that belongs to another server', async (t) => {
  const dir = await tempDir(t);
  await writeToken(dir, JSON.stringify(storedOAuth('http://127.0.0.1:2', { resource: 'http://127.0.0.1:3/api' })));
  await assert.rejects(
    whoami({ url: 'http://127.0.0.1:1', dir, env: {} }, {}),
    isUserError('the saved login is for another server: run headjack login --force'),
  );
});

test('whoami names the URL when the vault cannot be reached', async (t) => {
  const dir = await tempDir(t);
  const dead = await freePort();
  const url = `http://127.0.0.1:${dead}`;
  await assert.rejects(
    whoami({ url, dir, env: { HEADJACK_TOKEN: 'k' } }, {}),
    (e) => e instanceof UserError && e.message.includes(`${url}/api/updates`) && !e.message.includes('\n'),
  );
});
