import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod, mkdir, symlink, lstat, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadRemote } from '../../cli/config.mjs';
import { stateDir } from '../../cli/local-config.mjs';
import { createApi, ApiError } from '../../cli/api.mjs';
import { loadState, saveState, upsertEntry, findEntry } from '../../cli/state.mjs';
import { parseHarnessList, skillsDir, claudeSettingsPath } from '../../cli/harness.mjs';
import { setPluginsEnabled } from '../../cli/settings.mjs';
import { exec } from '../../cli/exec.mjs';
import { UserError } from '../../lib/errors.mjs';
import { tempDir } from '../helpers.mjs';

const NOT_LOGGED_IN = 'not logged in: run headjack login, or set HEADJACK_TOKEN (an API key)';
const KEY = { kind: 'api-key', token: 'tk', source: 'env' };

test('loadRemote reads HEADJACK_URL and HEADJACK_TOKEN only', async () => {
  const dir = path.join(await tempDir(), '.headjack');
  await assert.rejects(
    loadRemote({ env: {}, dir }),
    (e) => e instanceof UserError && e.message === 'HEADJACK_URL is not set (for example https://headjack.example.invalid)',
  );
  await assert.rejects(
    loadRemote({ env: { HEADJACK_URL: 'https://x' }, dir }),
    (e) => e instanceof UserError && e.message === NOT_LOGGED_IN,
  );
  assert.deepEqual(await loadRemote({ env: { HEADJACK_URL: 'https://x/', HEADJACK_TOKEN: 't' }, dir }), { url: 'https://x', credential: { kind: 'api-key', token: 't', source: 'env' } });
});

test('loadRemote reads env, then a chmod 600 token file', async () => {
  const dir = path.join(await tempDir(), '.headjack');
  assert.deepEqual(await loadRemote({ env: { HEADJACK_URL: 'https://x/', HEADJACK_TOKEN: 't' }, dir }), { url: 'https://x', credential: { kind: 'api-key', token: 't', source: 'env' } });
  await assert.rejects(loadRemote({ env: {}, dir }), (e) => e instanceof UserError && /HEADJACK_URL/.test(e.message));
  await assert.rejects(loadRemote({ env: { HEADJACK_URL: 'https://x' }, dir }), (e) => e instanceof UserError && e.message === NOT_LOGGED_IN);
  await mkdir(dir);
  const tokenFile = path.join(dir, 'token');
  await writeFile(tokenFile, 'filetoken\n');
  await chmod(tokenFile, 0o644);
  await assert.rejects(loadRemote({ env: { HEADJACK_URL: 'https://x' }, dir }), (e) => e instanceof UserError && e.message === `${tokenFile} has mode 644; run: chmod 600 ${tokenFile}`);
  await chmod(tokenFile, 0o600);
  assert.deepEqual((await loadRemote({ env: { HEADJACK_URL: 'https://x' }, dir })).credential, { kind: 'api-key', token: 'filetoken', source: 'file' });
});

test('loadRemote reads the token from <dir>/token', async () => {
  const home = await tempDir('sv-home-');
  const env = { HEADJACK_URL: 'https://x', HEADJACK_HOME: path.join(await tempDir('sv-state-'), 'state') };
  const dir = stateDir({ env, home });
  assert.equal(dir, env.HEADJACK_HOME);
  await mkdir(dir);
  await writeFile(path.join(dir, 'token'), 'from-headjack-home\n', { mode: 0o600 });
  await mkdir(path.join(home, '.headjack'));
  await writeFile(path.join(home, '.headjack', 'token'), 'from-home\n', { mode: 0o600 });
  assert.equal((await loadRemote({ env, dir })).credential.token, 'from-headjack-home');
  await assert.rejects(loadRemote({ env, dir: path.join(home, 'missing') }), (e) => e instanceof UserError && e.message === NOT_LOGGED_IN);
});

test('loadRemote rejects an empty token file', async () => {
  const dir = path.join(await tempDir(), '.headjack');
  await mkdir(dir);
  const tokenFile = path.join(dir, 'token');
  await writeFile(tokenFile, '  \n');
  await chmod(tokenFile, 0o600);
  await assert.rejects(loadRemote({ env: { HEADJACK_URL: 'https://x' }, dir }), (e) => e instanceof UserError && e.message === `${tokenFile} is not a valid credential; run headjack login --force`);
});

test('api client sends bearer, parses results and maps errors', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.authorization, init.method ?? 'GET']);
    if (url.includes('/api/search')) return Response.json({ results: [{ slug: 'a' }] });
    if (url.endsWith('/api/skills/missing')) return Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
    if (url.endsWith('/download')) return new Response(Buffer.from('TGZ'), { headers: { 'x-skill-sha256': 'f'.repeat(64) } });
    if (url.endsWith('/api/skills')) return Response.json({ skillId: 1, versionId: 2 }, { status: 201 });
    return Response.json({ error: { code: 'conflict', message: 'dup' } }, { status: 409 });
  };
  const api = createApi({ url: 'https://sv', credential: KEY, fetchImpl });
  assert.deepEqual(await api.search('render video', 3), [{ slug: 'a' }]);
  assert.equal(seen[0][0], 'https://sv/api/search?q=render+video&k=3');
  assert.equal(seen[0][1], 'Bearer tk');
  await api.search('godot script', 5, undefined, ['python', 'godot']);
  assert.equal(seen.at(-1)[0], 'https://sv/api/search?q=godot+script&k=5&tag=python%2Cgodot');
  assert.equal(await api.getSkill('missing'), null);
  const dl = await api.download('x:y');
  assert.equal(seen.at(-1)[0], 'https://sv/api/skills/x%3Ay/download');
  assert.equal(dl.tarball.toString(), 'TGZ');
  assert.deepEqual(await api.publish({ slug: 's' }, Buffer.from('t')), { skillId: 1, versionId: 2 });
  assert.equal(seen.at(-1)[2], 'POST');
  await assert.rejects(api.versions('x'), (e) => e instanceof ApiError && e.status === 409 && e.code === 'conflict');
  const offline = createApi({ url: 'https://sv', credential: KEY, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(offline.search('x'), (e) => e instanceof ApiError && e.status === 0);
});

test('api client forwards x-headjack-session only for a valid CLAUDE_CODE_SESSION_ID', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return Response.json({ results: [] }); };
  const api = (env) => createApi({ url: 'https://sv', credential: KEY, fetchImpl, env });
  await api({ CLAUDE_CODE_SESSION_ID: 'abc-123' }).search('x');
  assert.equal(seen.at(-1)['x-headjack-session'], 'abc-123');
  assert.equal(seen.at(-1).authorization, 'Bearer tk');
  await api({ CLAUDE_CODE_SESSION_ID: 'a'.repeat(64) }).getSkill('s');
  assert.equal(seen.at(-1)['x-headjack-session'], 'a'.repeat(64));
  for (const env of [{ CLAUDE_CODE_SESSION_ID: 'bad id' }, { CLAUDE_CODE_SESSION_ID: 'a'.repeat(65) }, { CLAUDE_CODE_SESSION_ID: '' }, {}]) {
    await api(env).search('x');
    assert.ok(!('x-headjack-session' in seen.at(-1)), JSON.stringify(env));
    assert.equal(seen.at(-1).authorization, 'Bearer tk');
  }
});

test('api.search sends x-headjack-purpose, manual by default', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return Response.json({ results: [] }); };
  const api = createApi({ url: 'https://sv', credential: KEY, fetchImpl, env: {} });
  await api.search('x', 8, undefined, [], 'suggest');
  assert.equal(seen.at(-1)['x-headjack-purpose'], 'suggest');
  await api.search('x');
  assert.equal(seen.at(-1)['x-headjack-purpose'], 'manual');
});

test('the CLI sends x-headjack-purpose and x-headjack-session', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return Response.json({ results: [] }); };
  await createApi({ url: 'https://sv', credential: KEY, fetchImpl, env: { CLAUDE_CODE_SESSION_ID: 'abc-123' } }).search('x', 8, undefined, [], 'plan');
  assert.equal(seen.at(-1)['x-headjack-purpose'], 'plan');
  assert.equal(seen.at(-1)['x-headjack-session'], 'abc-123');
  assert.deepEqual(Object.keys(seen.at(-1)).filter((h) => h.startsWith('x-') && !h.startsWith('x-headjack-')), []);
});

test('api.installEvent posts JSON to /api/events/install with a timeout signal', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, init]); return new Response(null, { status: 204 }); };
  const api = createApi({ url: 'https://sv', credential: KEY, fetchImpl, env: { CLAUDE_CODE_SESSION_ID: 'abc-123' } });
  assert.equal(await api.installEvent({ slug: 's', kind: 'skill', source: 'plan' }), undefined);
  const [url, init] = seen[0];
  assert.equal(url, 'https://sv/api/events/install');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.authorization, 'Bearer tk');
  assert.equal(init.headers['x-headjack-session'], 'abc-123');
  assert.deepEqual(JSON.parse(init.body), { slug: 's', kind: 'skill', source: 'plan' });
  assert.ok(init.signal instanceof AbortSignal);
});

test('api.installEvent resolves undefined when fetch rejects, returns 500 or never settles', async () => {
  const make = (fetchImpl) => createApi({ url: 'https://sv', credential: KEY, fetchImpl, env: {} });
  const event = { slug: 's', kind: 'skill', source: 'manual' };
  assert.equal(await make(async () => { throw new Error('ECONNREFUSED'); }).installEvent(event), undefined);
  assert.equal(await make(async () => Response.json({ error: { code: 'boom', message: 'x' } }, { status: 500 })).installEvent(event), undefined);
  // AbortSignal.timeout's timer is unref'd; a ref'd guard keeps the event loop alive until it fires.
  const guard = setTimeout(() => {}, 5000);
  try {
    const started = Date.now();
    assert.equal(await make(() => new Promise(() => {})).installEvent(event, { timeoutMs: 50 }), undefined);
    assert.ok(Date.now() - started < 2000, 'gave up after the timeout');
  } finally {
    clearTimeout(guard);
  }
});

test('exitCodeFor maps transient API failures to 3, user and other API errors to 2, the rest to 1', async () => {
  const { exitCodeFor } = await import('../../cli/exit.mjs');
  assert.equal(exitCodeFor(new ApiError(0, 'network', 'x')), 3);
  assert.equal(exitCodeFor(new ApiError(503, 'http_error', 'x')), 3);
  assert.equal(exitCodeFor(new ApiError(500, 'internal', 'x')), 3);
  assert.equal(exitCodeFor(new ApiError(404, 'not_found', 'x')), 2);
  assert.equal(exitCodeFor(new ApiError(409, 'conflict', 'x')), 2);
  assert.equal(exitCodeFor(new UserError('x')), 2);
  assert.equal(exitCodeFor(new Error('x')), 1);
  assert.equal(exitCodeFor(undefined), 0);
});

test('state round-trips atomically and merges targets', async () => {
  const dir = await tempDir();
  const s = await loadState(dir);
  assert.deepEqual(s, { version: 1, active: [] });
  upsertEntry(s, { slug: 'a', kind: 'skill', sha256: '1', targets: [{ harness: 'claude', path: '/c/a' }] });
  upsertEntry(s, { slug: 'a', kind: 'skill', sha256: '2', targets: [{ harness: 'codex', path: '/x/a' }, { harness: 'claude', path: '/c/a' }] });
  await saveState(dir, s);
  const back = await loadState(dir);
  assert.equal(findEntry(back, 'a').sha256, '2');
  assert.equal(findEntry(back, 'a').targets.length, 2);
  await writeFile(path.join(dir, 'state.json'), '{broken');
  await assert.rejects(loadState(dir), (e) => e instanceof UserError && /state.json/.test(e.message));
});

test('harness helpers', () => {
  assert.deepEqual(parseHarnessList(), ['claude', 'codex', 'grok']);
  assert.deepEqual(parseHarnessList('grok, claude'), ['grok', 'claude']);
  assert.throws(() => parseHarnessList('frobnicate'), UserError); // cursor is a known harness now
  assert.equal(skillsDir('codex', { home: '/h', cwd: '/p' }), '/h/.codex/skills');
  assert.equal(skillsDir('codex', { home: '/h', cwd: '/p', project: true }), '/p/.codex/skills');
  assert.equal(claudeSettingsPath({ home: '/h', cwd: '/p', project: true }), '/p/.claude/settings.json');
});

test('setPluginsEnabled preserves other keys and creates the file', async () => {
  const dir = await tempDir();
  const f = path.join(dir, '.claude', 'settings.json');
  await setPluginsEnabled(f, { 'a@m': true });
  assert.deepEqual(JSON.parse(await readFile(f, 'utf8')), { enabledPlugins: { 'a@m': true } });
  await writeFile(f, JSON.stringify({ model: 'x', enabledPlugins: { 'b@m': true } }));
  await setPluginsEnabled(f, { 'a@m': false });
  assert.deepEqual(JSON.parse(await readFile(f, 'utf8')), { model: 'x', enabledPlugins: { 'b@m': true, 'a@m': false } });
});

test('refuses malformed settings.json', async () => {
  const f = path.join(await tempDir(), 'settings.json');
  await writeFile(f, '{ "model": "x", }');
  await assert.rejects(setPluginsEnabled(f, { 'a@m': true }), (e) => e instanceof UserError && /is not valid JSON/.test(e.message));
  assert.equal(await readFile(f, 'utf8'), '{ "model": "x", }');
});

test('writes through a symlinked settings.json', async () => {
  const dir = await tempDir();
  const real = path.join(dir, 'dotfiles-settings.json');
  await writeFile(real, '{}');
  const link = path.join(dir, 'settings.json');
  await symlink(real, link);
  await setPluginsEnabled(link, { 'a@m': true });
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), { enabledPlugins: { 'a@m': true } });
});

test('refuses a dangling settings.json symlink without writing', async () => {
  const dir = await tempDir();
  const missing = path.join(dir, 'gone', 'settings.json');
  const link = path.join(dir, 'settings.json');
  await symlink(missing, link);
  await assert.rejects(setPluginsEnabled(link, { 'a@m': true }), (e) => e instanceof UserError && /is a broken symlink/.test(e.message));
  assert.ok((await lstat(link)).isSymbolicLink());
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('keeps the mode of an existing settings.json', async () => {
  const dir = await tempDir();
  const f = path.join(dir, 'settings.json');
  await writeFile(f, '{}');
  await chmod(f, 0o600);
  await setPluginsEnabled(f, { 'a@m': true });
  assert.equal((await stat(f)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('exec reports non-zero exit codes without throwing', async () => {
  assert.deepEqual(await exec('node', ['-e', 'process.stdout.write("hi"); process.exit(3)']), { code: 3, stdout: 'hi', stderr: '' });
});
