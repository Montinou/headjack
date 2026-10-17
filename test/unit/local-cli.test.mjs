// End to end: the spawned CLI in local mode (no HEADJACK_URL) over a SQLite vault in a temporary HEADJACK_HOME.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { localTest, zeroPagesAfterFirst } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { MIGRATIONS } from '../../lib/local/schema.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));

// A fresh HOME and HEADJACK_HOME; `env` adds to (or, with undefined values, removes from) the child's environment.
async function sandbox() {
  const home = await tempDir('sv-lhome-');
  const state = await tempDir('sv-lstate-');
  return { home, state, env: { HOME: home, HEADJACK_HOME: state } };
}

function runCli(args, { env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function skillAt(dir, name, description) {
  await fsp.mkdir(path.join(dir, name), { recursive: true });
  await fsp.writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nUse it.\n`);
  return path.join(dir, name);
}

const REVIEW_ANSWERS = 'n\na\nnotes\n\n';

localTest('review publishes into the vault, search finds it, whoami and verify read it', async () => {
  const { home, state, env } = await sandbox();
  const src = await skillAt(await tempDir('sv-lsrc-'), 'zebra-tracker', 'Tracks zebra migrations across savannas');
  const reviewed = await runCli(['review', src], { env, input: REVIEW_ANSWERS });
  assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);
  assert.match(reviewed.stdout, /zebra-tracker: approved/);

  const found = await runCli(['search', 'zebra'], { env });
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, /zebra-tracker/);
  assert.match(found.stdout, /Tracks zebra migrations/);

  const who = await runCli(['whoami'], { env });
  assert.equal(who.code, 0, who.stderr);
  assert.equal(who.stdout.trim(), `local vault ${path.join(state, 'vault.db')} (schema ${MIGRATIONS.length}, 1 skills)`);

  const verified = await runCli(['verify'], { env });
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /everything in order/);
  assert.ok(home);
});

localTest('an empty vault: search says no results and updates says everything is up to date', async () => {
  const { env } = await sandbox();
  const search = await runCli(['search', 'anything'], { env });
  assert.equal(search.code, 0, search.stderr);
  assert.equal(search.stdout.trim(), 'no results');
  const updates = await runCli(['updates'], { env });
  assert.equal(updates.code, 0, updates.stderr);
  assert.equal(updates.stdout.trim(), 'everything is up to date');
});

localTest('search --json reports active for a skill present only in ~/.claude/skills, and survives a corrupt harnesses.json', async () => {
  const { home, state, env } = await sandbox();
  const src = await skillAt(await tempDir('sv-lsrc-'), 'okapi-notes', 'Keeps okapi sighting notes for field researchers');
  const reviewed = await runCli(['review', src], { env, input: REVIEW_ANSWERS });
  assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr);

  const before = JSON.parse((await runCli(['search', 'okapi', '--json'], { env })).stdout);
  assert.equal(before.find((r) => r.slug === 'okapi-notes').active, false);

  await fsp.mkdir(path.join(home, '.claude', 'skills', 'okapi-notes'), { recursive: true });
  const after = JSON.parse((await runCli(['search', 'okapi', '--json'], { env })).stdout);
  assert.equal(after.find((r) => r.slug === 'okapi-notes').active, true);

  await fsp.writeFile(path.join(state, 'harnesses.json'), '{broken');
  const corrupt = await runCli(['search', 'okapi', '--json'], { env });
  assert.equal(corrupt.code, 0, corrupt.stdout + corrupt.stderr);
  assert.equal(JSON.parse(corrupt.stdout).find((r) => r.slug === 'okapi-notes').active, true);
});

localTest('import finds, publishes and re-publishes (as existing) skills from ~/.agents/skills, and add links one', async () => {
  const { home, env } = await sandbox();
  const root = path.join(home, '.agents', 'skills');
  await skillAt(root, 'alpha-skill', 'Alpha does alpha things');
  await skillAt(root, 'beta-skill', 'Beta does beta things');
  await skillAt(root, 'gamma-skill', 'Gamma does gamma things');

  const dry = await runCli(['import', '--dry-run'], { env });
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /local: 3/);

  const first = await runCli(['import', '--interactive'], { env, input: 'y\ny\ny\n' });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /published: 3/);
  assert.match(first.stdout, /already existed: 0/);

  const again = await runCli(['import', '--interactive'], { env, input: 'y\ny\ny\n' });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /published: 0/);
  assert.match(again.stdout, /already existed: 3/);
  assert.match(again.stdout, /failed: none/);

  const who = await runCli(['whoami'], { env });
  assert.match(who.stdout, /3 skills\)/);

  const added = await runCli(['add', 'beta-skill', '--to', 'claude'], { env });
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const link = path.join(home, '.claude', 'skills', 'beta-skill');
  assert.ok((await fsp.lstat(link)).isSymbolicLink());
  assert.match(await fsp.readFile(path.join(link, 'SKILL.md'), 'utf8'), /Beta does beta things/);
});

localTest('login and logout in local mode print the local-mode line and exit 0', async () => {
  const { state, env } = await sandbox();
  const line = `local mode: nothing to log in to (vault: ${path.join(state, 'vault.db')})`;
  const login = await runCli(['login'], { env });
  assert.equal(login.code, 0, login.stdout + login.stderr);
  assert.equal(login.stdout.trim(), line);
  const logout = await runCli(['logout'], { env });
  assert.equal(logout.code, 0, logout.stdout + logout.stderr);
  assert.equal(logout.stdout.trim(), line);
});

localTest('logout in local mode still runs the hosted logout when a token file exists', async () => {
  const { state, env } = await sandbox();
  const tokenFile = path.join(state, 'token');
  await fsp.writeFile(tokenFile, 'api-key-value\n', { mode: 0o600 });
  const res = await runCli(['logout'], { env });
  // The hosted logout refuses to touch an API key file; the point is that it ran instead of the local-mode line.
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), 'headjack: API keys are revoked on the server; the token file was left in place');
  assert.equal(await fsp.readFile(tokenFile, 'utf8'), 'api-key-value\n');
});

localTest('logout in local mode deletes a saved OAuth login file (and says it could not revoke it)', async () => {
  const { state, env } = await sandbox();
  const tokenFile = path.join(state, 'token');
  await fsp.writeFile(tokenFile, JSON.stringify({
    kind: 'oauth', issuer: 'http://127.0.0.1:1', client_id: 'client_cli', resource: 'http://127.0.0.1:2/api',
    email: 'ana@example.invalid', access_token: 'at-secret', refresh_token: 'rt-secret', expires_at: Date.now() + 3600e3,
  }), { mode: 0o600 });
  const res = await runCli(['logout'], { env });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /logged out/);
  await assert.rejects(fsp.stat(tokenFile), { code: 'ENOENT' });
});

const IMPLICIT_NOTE = 'headjack: HEADJACK_URL is not set, using the local vault; set HEADJACK_URL (or HEADJACK_MODE=remote) to use your hosted vault\n';

localTest('with a saved login and no HEADJACK_URL, a command that connects says once that it uses the local vault', async () => {
  const { state, env } = await sandbox();
  await fsp.writeFile(path.join(state, 'token'), 'api-key-value\n', { mode: 0o600 });
  const search = await runCli(['search', 'anything'], { env });
  assert.equal(search.code, 0, search.stdout + search.stderr);
  assert.equal(search.stderr, IMPLICIT_NOTE);
  assert.equal(search.stdout.trim(), 'no results');
  const updates = await runCli(['updates'], { env });
  assert.equal(updates.code, 0, updates.stdout + updates.stderr);
  assert.equal(updates.stderr, IMPLICIT_NOTE);
  assert.equal(updates.stdout.trim(), 'everything is up to date');
  // Commands that never connect stay silent.
  const listed = await runCli(['list'], { env });
  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  assert.equal(listed.stderr, '');
});

localTest('the implicit-local note is not printed with HEADJACK_MODE=local or without a token file', async () => {
  const withToken = await sandbox();
  await fsp.writeFile(path.join(withToken.state, 'token'), 'api-key-value\n', { mode: 0o600 });
  const explicit = await runCli(['search', 'anything'], { env: { ...withToken.env, HEADJACK_MODE: 'local' } });
  assert.equal(explicit.code, 0, explicit.stdout + explicit.stderr);
  assert.equal(explicit.stderr, '');
  assert.equal(explicit.stdout.trim(), 'no results');
  const without = await sandbox();
  const bare = await runCli(['search', 'anything'], { env: without.env });
  assert.equal(bare.code, 0, bare.stdout + bare.stderr);
  assert.equal(bare.stderr, '');
  assert.equal(bare.stdout.trim(), 'no results');
});

localTest('an HEADJACK_HOME that cannot be created is one line naming the path, with no stack', async () => {
  const { home } = await sandbox();
  const blocker = path.join(home, 'a-file');
  await fsp.writeFile(blocker, 'x');
  const bad = path.join(blocker, 'state');
  const res = await runCli(['search', 'anything'], { env: { HOME: home, HEADJACK_HOME: bad } });
  assert.notEqual(res.code, 0);
  assert.equal(res.stderr.trim().split('\n').length, 1, res.stderr);
  assert.ok(res.stderr.includes(bad), res.stderr);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

localTest('a state directory under an unwritable parent is one line naming the path too', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root can write anywhere');
  const { home } = await sandbox();
  const parent = path.join(home, 'locked');
  await fsp.mkdir(parent, { mode: 0o700 });
  await fsp.chmod(parent, 0o500);
  const state = path.join(parent, 'state');
  const res = await runCli(['search', 'anything'], { env: { HOME: home, HEADJACK_HOME: state } });
  await fsp.chmod(parent, 0o700);
  assert.notEqual(res.code, 0);
  assert.equal(res.stderr.trim().split('\n').length, 1, res.stderr);
  assert.ok(res.stderr.includes(state), res.stderr);
});

localTest('a corrupt vault.db is reported and left untouched', async () => {
  const { state, env } = await sandbox();
  const file = path.join(state, 'vault.db');
  await fsp.writeFile(file, 'this is not a database, just text that is long enough to look like a header');
  const before = await fsp.readFile(file);
  const res = await runCli(['search', 'anything'], { env });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.ok(res.stderr.includes(file), res.stderr);
  assert.deepEqual(await fsp.readFile(file), before);
});

localTest('a vault with damaged pages is one line saying so and pointing at verify, exit 2, no stack', async () => {
  const { state, env } = await sandbox();
  const src = await skillAt(await tempDir('sv-lsrc-'), 'zebra-tracker', 'Tracks zebra migrations across savannas');
  assert.equal((await runCli(['review', src], { env, input: REVIEW_ANSWERS })).code, 0);
  const file = path.join(state, 'vault.db');
  await zeroPagesAfterFirst(file);
  const res = await runCli(['search', 'zebra'], { env });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr, `headjack: vault ${file} is damaged; run headjack verify\n`);
  assert.equal(res.stdout, '');
  const verified = await runCli(['verify'], { env });
  assert.equal(verified.code, 1, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /✗ vault integrity check failed/);
});

localTest('whoami on a vault with damaged pages is the same one line and exit 2, no raw SQLite text', async () => {
  const { state, env } = await sandbox();
  const src = await skillAt(await tempDir('sv-lsrc-'), 'zebra-tracker', 'Tracks zebra migrations across savannas');
  assert.equal((await runCli(['review', src], { env, input: REVIEW_ANSWERS })).code, 0);
  const file = path.join(state, 'vault.db');
  await zeroPagesAfterFirst(file);
  const res = await runCli(['whoami'], { env });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr, `headjack: vault ${file} is damaged; run headjack verify\n`);
  assert.equal(res.stdout, '');
});

localTest('HEADJACK_DEBUG prints the cause of a failed runtime check; without it there is one line only', async () => {
  const { env } = await sandbox();
  const run = (extra) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-experimental-sqlite', CLI, 'search', 'x'], { env: { PATH: process.env.PATH, ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const plain = await run({});
  assert.equal(plain.code, 2, plain.stderr);
  assert.match(plain.stderr, /^headjack: local mode needs a Node with SQLite FTS5/);
  assert.equal(plain.stderr.trim().split('\n').length, 1, plain.stderr);
  const debug = await run({ HEADJACK_DEBUG: '1' });
  assert.equal(debug.code, 2, debug.stderr);
  assert.match(debug.stderr, /Caused by: /);
});

localTest('HEADJACK_MODE=bogus exits 2 and names the choices', async () => {
  const { env } = await sandbox();
  const res = await runCli(['search', 'x'], { env: { ...env, HEADJACK_MODE: 'bogus' } });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), 'headjack: HEADJACK_MODE must be local or remote');
});

localTest('HEADJACK_MODE=local wins over HEADJACK_URL, and HEADJACK_URL alone selects remote', async () => {
  const { env } = await sandbox();
  const local = await runCli(['search', 'anything'], { env: { ...env, HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't', HEADJACK_MODE: 'local' } });
  assert.equal(local.code, 0, local.stdout + local.stderr);
  assert.equal(local.stdout.trim(), 'no results');
  const remote = await runCli(['search', 'anything'], { env: { ...env, HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't' } });
  assert.equal(remote.code, 3, remote.stdout + remote.stderr);
  assert.match(remote.stderr, /could not connect to http:\/\/127\.0\.0\.1:9/);
});

localTest('verify exits 1 when the vault fails its integrity check', async () => {
  const { state, env } = await sandbox();
  const src = await skillAt(await tempDir('sv-lsrc-'), 'zebra-tracker', 'Tracks zebra migrations across savannas');
  assert.equal((await runCli(['review', src], { env, input: REVIEW_ANSWERS })).code, 0);
  // Damage a page after the header (page 1 holds the schema, which open reads): the file still opens.
  const file = path.join(state, 'vault.db');
  const handle = await fsp.open(file, 'r+');
  try {
    const { size } = await handle.stat();
    const pageSize = 4096;
    assert.ok(size >= pageSize * 3, `vault is ${size} bytes`);
    await handle.write(Buffer.alloc(pageSize, 0xff), 0, pageSize, pageSize * 2);
  } finally {
    await handle.close();
  }
  const res = await runCli(['verify'], { env });
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /✗ vault integrity check failed/, res.stderr);
});
