// The client once honoured a hosting protection-bypass secret, a flag-override cookie and the former product's
// URL/TOKEN variables. They were removed; these tests pin the removal
// by the literal names: each removed option stays rejected or ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApi } from '../../cli/api.mjs';
import { loadRemote } from '../../cli/config.mjs';
import { readCredential, writeOAuthCredential } from '../../cli/credentials.mjs';
import { exec } from '../../cli/exec.mjs';
import { login, whoami } from '../../cli/login.mjs';
import { UserError } from '../../lib/errors.mjs';
import { startHeadjack, startIssuer } from '../fixtures/fake-oauth-servers.mjs';
import { tempDir } from '../helpers.mjs';

const SENTINEL = 'sekret-value';
const BYPASS_ENV = 'VERCEL_AUTOMATION_BYPASS_SECRET';
const OVERRIDE_ENV = 'HEADJACK_FLAG_OVERRIDES';
const FORMER = 'SKILLVAULT';
const HEADJACK = 'https://headjack.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const NOT_LOGGED_IN = 'not logged in: run headjack login, or set HEADJACK_TOKEN (an API key)';
const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const SKILL_FINDER = new URL('../../skill-finder/SKILL.md', import.meta.url);

async function scratch(t) {
  const dir = await tempDir('sv-removed-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('createApi sends no bypass header and no override cookie whatever the environment holds', async (t) => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers ?? {}, init });
    return json({ results: [] });
  };
  const dir = await scratch(t);
  await writeOAuthCredential(dir, {
    kind: 'oauth', source: 'file', issuer: ISSUER, clientId: 'client_cli', resource: `${HEADJACK}/api`, email: 'user@example.invalid',
    accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3600e3,
  });
  const stored = await readCredential({ env: {}, dir });
  const env = { [BYPASS_ENV]: SENTINEL, [OVERRIDE_ENV]: SENTINEL };
  const api = createApi({ url: HEADJACK, credential: stored, dir, fetchImpl, env });
  await api.search('a');
  await api.installEvent({ slug: 's', kind: 'skill', source: 'plan' });
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.deepEqual(Object.keys(r.headers).filter((h) => /bypass|cookie/i.test(h)), []);
    assert.ok(!JSON.stringify(r.headers).includes(SENTINEL));
    assert.equal(r.init.redirect, undefined);
  }
});

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The browser performs the callback GET the issuer's redirect would cause.
const openUrl = async (url) => {
  const authorize = new URL(url);
  const callback = new URL(authorize.searchParams.get('redirect_uri'));
  callback.searchParams.set('code', 'code-1');
  callback.searchParams.set('state', authorize.searchParams.get('state'));
  await fetch(callback);
};

test('login sends no bypass header to any server whatever the environment holds', async (t) => {
  const dir = await scratch(t);
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin });
  t.after(async () => { await Promise.all([issuer.close(), headjack.close()]); });
  const port = await freePort();
  const env = { [BYPASS_ENV]: SENTINEL, [OVERRIDE_ENV]: SENTINEL };
  await login({ url: headjack.origin, dir, force: false, env }, { openUrl, ports: [port], log: () => {} });
  assert.ok(headjack.requests.some((r) => r.path === '/api/updates'));
  for (const request of [...headjack.requests, ...issuer.requests]) {
    assert.deepEqual(Object.keys(request.headers).filter((h) => /bypass|cookie/i.test(h)), [], request.path);
    assert.ok(!JSON.stringify(request.headers).includes(SENTINEL), request.path);
  }
});

test('whoami sends no bypass header whatever the environment holds', async (t) => {
  const dir = await scratch(t);
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin });
  t.after(async () => { await Promise.all([issuer.close(), headjack.close()]); });
  await writeOAuthCredential(dir, {
    kind: 'oauth', source: 'file', issuer: issuer.origin, clientId: 'client_cli', resource: `${headjack.origin}/api`, email: 'old@example.invalid',
    accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 3600e3,
  });
  await whoami({ url: headjack.origin, dir, env: { [BYPASS_ENV]: SENTINEL, [OVERRIDE_ENV]: SENTINEL } }, {});
  const probe = headjack.requests.find((r) => r.path === '/api/updates');
  assert.ok(probe, 'the probe reached the server');
  assert.deepEqual(Object.keys(probe.headers).filter((h) => /bypass|cookie/i.test(h)), []);
  assert.ok(!JSON.stringify(probe.headers).includes(SENTINEL));
});

test('the former product name\'s URL and TOKEN variables are ignored', async (t) => {
  const dir = path.join(await scratch(t), '.headjack');
  await assert.rejects(
    loadRemote({ env: { [`${FORMER}_URL`]: 'https://x', [`${FORMER}_TOKEN`]: 't' }, dir }),
    (e) => e instanceof UserError && e.message === 'HEADJACK_URL is not set (for example https://headjack.example.invalid)',
  );
  await assert.rejects(
    loadRemote({ env: { HEADJACK_URL: 'https://x', [`${FORMER}_TOKEN`]: 't' }, dir }),
    (e) => e instanceof UserError && e.message === NOT_LOGGED_IN,
  );
});

test('help output and the skill document do not mention the former product name', async (t) => {
  const home = await scratch(t);
  const help = await exec('node', [CLI, '--help'], { env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(help.code, 0, help.stderr);
  assert.doesNotMatch(help.stdout, new RegExp(FORMER, 'i'));
  assert.doesNotMatch(await readFile(SKILL_FINDER, 'utf8'), new RegExp(FORMER, 'i'));
});
