// `headjack suggest` (spec §3.1 manual column, §3.7, §5.1, §11, §12): the spawned CLI over a SQLite vault in a temporary
// HEADJACK_HOME, with no HEADJACK_URL, so every run is local mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('../../cli/headjack', import.meta.url));

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function sandbox() {
  const home = await tempDir('sv-sg-home-');
  const state = await tempDir('sv-sg-state-');
  return { home, state, env: { HOME: home, HEADJACK_HOME: state } };
}

let sha = 0;
const skill = (slug, description, body) => ({
  manifest: {
    slug, name: slug, description, kind: 'skill', plugin_slug: null, tags: [], source: { kind: 'local' },
    sha256: String((sha += 1)).padStart(64, '0'), status: 'approved', review_notes: 'ok', scan_flags: [],
  },
  tarball: null,
  chunks: [{ text: body, kind: 'content' }],
});

// A sandbox whose vault holds one skill that PROMPT matches and one that it does not.
async function seeded() {
  const box = await sandbox();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir: box.state, DatabaseSync });
  const repo = createSqliteRepo(db);
  await repo.publish(skill('zq-helper', 'Run recurring jobs periodically with cron', 'Sets up a crontab for recurring jobs.'));
  await repo.publish(skill('gardening', 'Grow tomatoes', 'Water daily.'));
  db.close();
  return box;
}

const PROMPT = 'please run my recurring jobs periodically using cron on the staging servers';
const readConfig = async (state) => JSON.parse(await fsp.readFile(path.join(state, 'config.json'), 'utf8'));

// ---- --enable / --disable ----

test('--enable sets enabled and leaves hosted; --enable --hosted sets both; --enable --local sets hosted false; --disable sets enabled false', async () => {
  const { state, env } = await sandbox();
  let res = await runCli(['suggest', '--enable'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual((await readConfig(state)).suggest, { enabled: true });

  res = await runCli(['suggest', '--enable', '--hosted'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual((await readConfig(state)).suggest, { enabled: true, hosted: true });

  res = await runCli(['suggest', '--disable'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual((await readConfig(state)).suggest, { enabled: false, hosted: true });

  // --enable alone leaves hosted as it is.
  res = await runCli(['suggest', '--enable'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual((await readConfig(state)).suggest, { enabled: true, hosted: true });

  res = await runCli(['suggest', '--enable', '--local'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual((await readConfig(state)).suggest, { enabled: true, hosted: false });
});

test('--enable keeps the other keys of config.json', async () => {
  const { state, env } = await sandbox();
  await fsp.writeFile(path.join(state, 'config.json'), JSON.stringify({ excludedRoots: ['~/work'], suggest: { maxSuggestions: 3 } }));
  const res = await runCli(['suggest', '--enable'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(await readConfig(state), { excludedRoots: ['~/work'], suggest: { maxSuggestions: 3, enabled: true } });
});

test('bad flag combinations exit 2: --hosted with --local, --enable with --disable, --hosted or --local alone, text with --enable', async () => {
  const { state, env } = await sandbox();
  for (const args of [
    ['suggest', '--enable', '--hosted', '--local'],
    ['suggest', '--enable', '--disable'],
    ['suggest', '--hosted'],
    ['suggest', '--local'],
    ['suggest', '--disable', '--hosted'],
    ['suggest', '--enable', PROMPT],
  ]) {
    const res = await runCli(args, env);
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /^headjack: /);
  }
  assert.equal(existsSync(path.join(state, 'config.json')), false, 'a rejected combination writes nothing');
});

test('suggest without text exits 2 with the usage line', async () => {
  const { env } = await sandbox();
  const res = await runCli(['suggest'], env);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage: headjack suggest/);
});

// ---- the search ----

localTest('suggest "<text>" on a local vault prints the fenced block with the launcher and the local pin', async () => {
  const { env } = await seeded();
  const res = await runCli(['suggest', PROMPT], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^<headjack-suggestions note="/);
  assert.match(res.stdout, /^- zq-helper — Run recurring jobs periodically with cron$/m);
  assert.doesNotMatch(res.stdout, /gardening/);
  assert.ok(res.stdout.includes(`HEADJACK_MODE=local '${LAUNCHER}' add <slug> --to claude --session --source suggest`), res.stdout);
  assert.doesNotMatch(res.stdout, /HEADJACK_URL/);
});

localTest('suggest --json prints { outcome, mode, suggestions, candidates } and nothing else', async () => {
  const { env } = await seeded();
  const res = await runCli(['suggest', PROMPT, '--json'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['candidates', 'mode', 'outcome', 'suggestions']);
  assert.equal(out.outcome, 'suggested');
  assert.equal(out.mode, 'local');
  assert.deepEqual(out.suggestions.map((s) => s.slug), ['zq-helper']);
  assert.deepEqual(out.candidates.map((c) => c.slug), ['zq-helper']);
  assert.equal(out.candidates[0].passed, true);
  assert.equal(out.candidates[0].rejected_by, null);
});

localTest('suggest --explain lists every candidate with the filter that rejected it', async () => {
  const { env } = await seeded();
  // A second run with the skill already active: the candidate is rejected by "active".
  await fsp.mkdir(path.join(env.HOME, '.claude', 'skills', 'zq-helper'), { recursive: true });
  const res = await runCli(['suggest', PROMPT, '--explain'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.doesNotMatch(res.stdout, /<headjack-suggestions/);
  assert.match(res.stdout, /zq-helper/);
  assert.match(res.stdout, /rejected_by=active/);
  const open = await runCli(['suggest', PROMPT, '--explain'], { ...env, HOME: (await sandbox()).home });
  assert.equal(open.code, 0, open.stdout + open.stderr);
  assert.match(open.stdout, /^- zq-helper/m, 'the block still prints');
  assert.match(open.stdout, /zq-helper.*passed=true.*rejected_by=-/);
});

test('with no vault suggest exits 0 with empty stdout, with and without --json, and creates no vault', async () => {
  const { state, env } = await sandbox();
  for (const extra of [[], ['--json']]) {
    const res = await runCli(['suggest', PROMPT, ...extra], env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(res.stdout, '');
  }
  assert.equal(existsSync(path.join(state, 'vault.db')), false);
});

localTest('a short prompt and a prompt nothing matches exit 0 with a one-line note', async () => {
  const { env } = await seeded();
  const short = await runCli(['suggest', 'too short'], env);
  assert.equal(short.code, 0, short.stdout + short.stderr);
  assert.match(short.stdout, /no suggestions \(skipped:short\)/);
  const none = await runCli(['suggest', 'a prompt about astronomy and distant galaxies and nebulae'], env);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /no suggestions \(none\)/);
});

// ---- log ----

localTest('the run event is entry manual and holds no substring of the prompt longer than 3 characters', async () => {
  const { state, env } = await seeded();
  const res = await runCli(['suggest', PROMPT], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const logFile = path.join(state, 'suggest', 'log.jsonl');
  const text = await fsp.readFile(logFile, 'utf8');
  const events = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, 'run');
  assert.equal(event.entry, 'manual');
  assert.equal(event.mode, 'local');
  assert.equal(event.outcome, 'suggested');
  assert.equal(event.session, null);
  assert.deepEqual(event.candidates.map((c) => c.slug), ['zq-helper']);
  const haystack = text.toLowerCase();
  const needle = PROMPT.toLowerCase();
  for (let i = 0; i + 4 <= needle.length; i += 1) {
    const piece = needle.slice(i, i + 4);
    assert.ok(!haystack.includes(piece), `the log holds "${piece}" from the prompt`);
  }
  assert.equal((await fsp.stat(logFile)).mode & 0o777, 0o600);
});

test('a run that is skipped for lack of a vault still writes a run event', async () => {
  const { state, env } = await sandbox();
  await runCli(['suggest', PROMPT], env);
  const [event] = (await fsp.readFile(path.join(state, 'suggest', 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(event.outcome, 'skipped:no-vault');
  assert.equal(event.entry, 'manual');
});

// ---- --session-id ----

test('--session-id must match ^[A-Za-z0-9-]{1,64}$: anything else exits 2 and touches nothing', async () => {
  const { state, env } = await sandbox();
  for (const bad of ['../x', 'a/b', 'a b', '', 'x'.repeat(65), 'sé']) {
    const res = await runCli(['suggest', PROMPT, '--session-id', bad], env);
    assert.equal(res.code, 2, `"${bad}": ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /--session-id/);
  }
  assert.equal(existsSync(path.join(state, 'suggest')), false);
});

localTest('--session-id dedupes across runs through <dir>/suggest/sessions/<id>.json; without it nothing is stored', async () => {
  const { state, env } = await seeded();
  const sessions = path.join(state, 'suggest', 'sessions');

  const plain = await runCli(['suggest', PROMPT], env);
  assert.match(plain.stdout, /zq-helper/);
  assert.equal(existsSync(sessions), false, 'no --session-id: no session file');

  const first = await runCli(['suggest', PROMPT, '--session-id', 'abc-123', '--json'], env);
  assert.equal(JSON.parse(first.stdout).outcome, 'suggested');
  const file = path.join(sessions, 'abc-123.json');
  assert.deepEqual((await fsp.readdir(sessions)), ['abc-123.json']);
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(sessions)).mode & 0o777, 0o700);

  const second = await runCli(['suggest', PROMPT, '--session-id', 'abc-123', '--json'], env);
  const out = JSON.parse(second.stdout);
  assert.equal(out.outcome, 'none');
  assert.equal(out.candidates[0].rejected_by, 'seen');

  const other = await runCli(['suggest', PROMPT, '--session-id', 'other-session', '--json'], env);
  assert.equal(JSON.parse(other.stdout).outcome, 'suggested');

  const events = (await fsp.readFile(path.join(state, 'suggest', 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.session), [null, 'abc-123', 'abc-123', 'other-session']);
});

test('add <slug> --session still parses --session as a boolean, next to the new --session-id string', async () => {
  const { env } = await sandbox();
  const res = await runCli(['add', 'does-not-exist', '--session'], env);
  assert.doesNotMatch(res.stderr, /Unknown option|expects a value|argument missing/i, res.stderr);
  const withId = await runCli(['add', 'does-not-exist', '--session', '--session-id', 'abc'], env);
  assert.doesNotMatch(withId.stderr, /Unknown option|expects a value|argument missing/i, withId.stderr);
});

// ---- a malformed suggest key (Review Focus 5) ----

localTest('a malformed suggest key breaks only `suggest`: add, search and import --dry-run behave as without it', async () => {
  const bad = await seeded();
  const good = await seeded();
  await fsp.writeFile(path.join(bad.state, 'config.json'), JSON.stringify({ suggest: { enabled: 'yes' } }));
  for (const args of [['add', 'does-not-exist'], ['search', 'recurring jobs'], ['import', '--dry-run']]) {
    const withBad = await runCli(args, bad.env);
    const without = await runCli(args, good.env);
    assert.equal(withBad.code, without.code, `${args.join(' ')}: ${withBad.stderr} vs ${without.stderr}`);
    assert.doesNotMatch(withBad.stderr, /suggest/);
  }
  const res = await runCli(['suggest', PROMPT], bad.env);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /suggest\.enabled/);
});

test('--enable on a malformed suggest key exits 2 and leaves the file alone', async () => {
  const { state, env } = await sandbox();
  const raw = JSON.stringify({ suggest: { maxSuggestions: 0 } });
  await fsp.writeFile(path.join(state, 'config.json'), raw);
  const res = await runCli(['suggest', '--enable'], env);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /suggest\.maxSuggestions/);
  assert.equal(await fsp.readFile(path.join(state, 'config.json'), 'utf8'), raw);
});

// ---- hosted ----

test('suggest.hosted without any URL ends skipped:no-url with exit 0', async () => {
  const { state, env } = await sandbox();
  await fsp.writeFile(path.join(state, 'config.json'), JSON.stringify({ suggest: { hosted: true } }));
  const res = await runCli(['suggest', PROMPT], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const [event] = (await fsp.readFile(path.join(state, 'suggest', 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(event.mode, 'hosted');
  assert.equal(event.outcome, 'skipped:no-url');
});

test('an unreachable hosted server exits 3 and logs an error run; HEADJACK_MODE and HEADJACK_URL alone never make suggest hosted', async () => {
  const { state, env } = await sandbox();
  await fsp.writeFile(path.join(state, 'config.json'), JSON.stringify({ suggest: { hosted: true } }));
  const res = await runCli(['suggest', PROMPT], { ...env, HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't' });
  assert.equal(res.code, 3, res.stdout + res.stderr);
  assert.doesNotMatch(res.stderr, /recurring/);
  const [event] = (await fsp.readFile(path.join(state, 'suggest', 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(event.outcome, 'error');
  assert.equal(event.mode, 'hosted');

  const other = await sandbox();
  const local = await runCli(['suggest', PROMPT, '--json'], { ...other.env, HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't', HEADJACK_MODE: 'remote' });
  assert.equal(local.code, 0, local.stdout + local.stderr);
  assert.equal(local.stdout, '', 'no local vault: silent, and no network call was made');
});

// ---- fix round 1 ----

localTest('an unreadable state.json is the error outcome: exit 1, the JSON object under --json, a message otherwise', async () => {
  const { state, env } = await seeded();
  await fsp.writeFile(path.join(state, 'state.json'), '{broken');
  const json = await runCli(['suggest', PROMPT, '--json'], env);
  assert.equal(json.code, 1, json.stdout + json.stderr);
  const out = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['candidates', 'mode', 'outcome', 'suggestions']);
  assert.equal(out.outcome, 'error');
  assert.deepEqual(out.suggestions, []);
  const plain = await runCli(['suggest', PROMPT], env);
  assert.equal(plain.code, 1, plain.stdout + plain.stderr);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /^headjack: could not read/);
  const events = (await fsp.readFile(path.join(state, 'suggest', 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.outcome), ['error', 'error']);
});

localTest('--explain prints a placeholder for a candidate slug that fails the vault slug pattern', async () => {
  const { state, env } = await seeded();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir: state, DatabaseSync });
  const hostile = 'zq-helper\u001b[31m <script>';
  db.prepare('UPDATE skills SET slug = ? WHERE slug = ?').run(hostile, 'zq-helper');
  db.close();
  const res = await runCli(['suggest', PROMPT, '--explain'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.ok(!res.stdout.includes('\u001b'), 'no escape character reaches the terminal');
  assert.ok(!res.stdout.includes('<script>'));
  assert.match(res.stdout, /^ {2}<invalid slug> {2}fts_rank=/m);
});
