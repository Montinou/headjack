// `headjack suggest` (spec §3.1 manual column, §3.7, §5.1, §11, §12): the spawned CLI over a SQLite vault in a temporary
// HEADJACK_HOME, with no HEADJACK_URL, so every run is local mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { loadVec } from '../../lib/local/vec.mjs';
import { loadSuggestConfig } from '../../lib/suggest-config.mjs';
import { calibrate } from '../../lib/suggest-calibrate.mjs';
import { suggestDeps } from '../../cli/suggest-deps.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('../../cli/headjack', import.meta.url));

// `preload` is module source that runs in the child before the CLI (node --import data:…): the calibration tests use it to
// replace globalThis.fetch, since a child process cannot be handed a fetchImpl.
function runCli(args, env, { preload } = {}) {
  const imports = preload === undefined ? [] : ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
  return new Promise((resolve, reject) => {
    const child = spawn('node', [...imports, CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
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

localTest('a vault.db that is not a database is reported like search does: exit 2, the damaged-vault line, file untouched', async () => {
  const box = await sandbox();
  const file = path.join(box.state, 'vault.db');
  const junk = Buffer.from('these are my notes, not a database\n'.repeat(40));
  await fsp.writeFile(file, junk);
  const res = await runCli(['suggest', PROMPT], box.env);
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr, `headjack: vault ${file} is damaged; run headjack verify\n`);
  assert.equal(res.stdout, '');
  assert.deepEqual(await fsp.readFile(file), junk);
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

// ---- --save: real prompts kept locally as calibration cases (spec §5.4) ----

// Like runCli, with `input` piped to stdin.
function runCliWithInput(args, env, input) {
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

// Runs the CLI with a pseudo-terminal as stdin and stdout (python3's pty), so process.stdin.isTTY is true.
const PTY_RUNNER = 'import os, pty, sys\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
const hasPython = await new Promise((resolve) => {
  const p = spawn('python3', ['-I', '-c', 'import pty, os; os.waitstatus_to_exitcode'], { stdio: 'ignore' });
  p.on('error', () => resolve(false));
  p.on('close', (code) => resolve(code === 0));
});
function runCliOnTty(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', PTY_RUNNER, 'node', CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}
const ttyTest = (name, fn) => (hasPython ? test(name, fn) : test.skip(`${name} (skipped: no python3 for a pseudo-terminal)`, fn));

const casesFile = (state) => path.join(state, 'suggest', 'cases.jsonl');
const readCases = async (state) => (await fsp.readFile(casesFile(state), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// An executable that stands in for an editor: it writes `text` into the file it is given (its last argument), and records
// that path and its argument count next to itself.
async function fakeEditor(text) {
  const dir = await tempDir('sv-sg-editor-');
  const script = path.join(dir, 'editor.sh');
  await fsp.writeFile(script, `#!/bin/sh\nfor last; do :; done\nprintf '%s' '${text}' > "$last"\nprintf '%s\\n%s\\n' "$last" "$#" > "${dir}/seen"\n`, { mode: 0o755 });
  return { script, seen: async () => (await fsp.readFile(path.join(dir, 'seen'), 'utf8')).split('\n') };
}

test('--save reads the prompt from piped stdin and appends { q, slug, lang, at } to cases.jsonl (0600, dir 0700)', async () => {
  const { state, env } = await sandbox();
  const res = await runCliWithInput(['suggest', '--save', '--expect', 'none', '--lang', 'es'], env, 'agregar flags\n');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const cases = await readCases(state);
  assert.equal(cases.length, 1);
  assert.deepEqual(Object.keys(cases[0]).sort(), ['at', 'lang', 'q', 'slug']);
  assert.deepEqual([cases[0].q, cases[0].slug, cases[0].lang], ['agregar flags', null, 'es']);
  assert.ok(Number.isFinite(Date.parse(cases[0].at)));
  assert.equal((await fsp.stat(casesFile(state))).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(path.join(state, 'suggest'))).mode & 0o777, 0o700);
  assert.doesNotMatch(res.stdout + res.stderr, /agregar flags/, 'the prompt is not echoed');
});

test('--save --expect <slug> stores the slug; --lang defaults to the language guess; cases append', async () => {
  const { state, env } = await sandbox();
  let res = await runCliWithInput(['suggest', '--save', '--expect', 'zq-helper'], env, 'quiero programar tareas con cron para el servidor');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  res = await runCliWithInput(['suggest', '--save', '--expect', 'none'], env, 'schedule the recurring jobs with cron');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const cases = await readCases(state);
  assert.deepEqual(cases.map((c) => [c.slug, c.lang]), [['zq-helper', 'es'], [null, 'en']]);
});

test('--save never writes the prompt to the suggest log', async () => {
  const { state, env } = await sandbox();
  const res = await runCliWithInput(['suggest', '--save', '--expect', 'none'], env, 'a secret prompt');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(existsSync(path.join(state, 'suggest', 'log.jsonl')), false);
});

test('--save with positional text exits 2 and writes no file', async () => {
  const { state, env } = await sandbox();
  const res = await runCliWithInput(['suggest', '--save', '--expect', 'none', PROMPT], env, 'ignored');
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /^headjack: .*(argv|stdin|editor)/);
  assert.equal(existsSync(casesFile(state)), false);
});

test('--save without --expect exits 2 and writes no file', async () => {
  const { state, env } = await sandbox();
  const res = await runCliWithInput(['suggest', '--save'], env, 'agregar flags');
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /--expect/);
  assert.equal(existsSync(casesFile(state)), false);
});

test('bad --save values exit 2: empty stdin, an invalid slug, an invalid --lang, --expect or --lang without --save, --save with another mode', async () => {
  const { state, env } = await sandbox();
  for (const [args, input] of [
    [['suggest', '--save', '--expect', 'none'], '  \n'],
    [['suggest', '--save', '--expect', 'Not A Slug!'], 'x'],
    [['suggest', '--save', '--expect', 'none', '--lang', 'fr'], 'x'],
    [['suggest', '--expect', 'none', PROMPT], ''],
    [['suggest', '--lang', 'es', PROMPT], ''],
    [['suggest', '--save', '--expect', 'none', '--report'], 'x'],
    [['suggest', '--save', '--expect', 'none', '--enable'], 'x'],
    [['suggest', '--save', '--expect', 'none', '-k', '3'], 'x'],
    [['suggest', '--save', '--expect', 'none', '--tag', 'a'], 'x'],
    [['suggest', '--save', '--expect', 'none', '--purpose', 'eval'], 'x'],
    [['suggest', '--save', '--expect', 'none', '--project'], 'x'],
  ]) {
    const res = await runCliWithInput(args, env, input);
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /^headjack: /);
  }
  assert.equal(existsSync(casesFile(state)), false);
});

ttyTest('--save on a terminal opens $VISUAL before $EDITOR, with a file in a private temp dir that is removed afterwards', async () => {
  const { state, env } = await sandbox();
  const visual = await fakeEditor('from visual');
  const editor = await fakeEditor('from editor');
  const res = await runCliOnTty(['suggest', '--save', '--expect', 'zq-helper', '--lang', 'en'], { ...env, VISUAL: visual.script, EDITOR: editor.script });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual((await readCases(state)).map((c) => [c.q, c.slug, c.lang]), [['from visual', 'zq-helper', 'en']]);
  const [file] = await visual.seen();
  assert.equal(existsSync(path.dirname(file)), false, 'the temp dir is removed');
  assert.equal(existsSync(editor.script) && (await fsp.readdir(path.dirname(editor.script))).includes('seen'), false, '$EDITOR was not run');
});

ttyTest('--save on a terminal falls back to $EDITOR, which may carry arguments', async () => {
  const { state, env } = await sandbox();
  const editor = await fakeEditor('from editor');
  const res = await runCliOnTty(['suggest', '--save', '--expect', 'none'], { ...env, EDITOR: `${editor.script} -w` });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal((await readCases(state))[0].q, 'from editor');
  assert.equal((await editor.seen())[1], '2', 'the editor got "-w" and the file');
});

ttyTest('--save on a terminal with neither $VISUAL nor $EDITOR exits 2 and writes no file', async () => {
  const { state, env } = await sandbox();
  const res = await runCliOnTty(['suggest', '--save', '--expect', 'none'], env);
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /VISUAL|EDITOR/);
  assert.equal(existsSync(casesFile(state)), false);
});

ttyTest('--save with an editor that fails writes no case and still removes the temp dir', async () => {
  const { state, env } = await sandbox();
  const dir = await tempDir('sv-sg-editor-');
  const script = path.join(dir, 'fail.sh');
  await fsp.writeFile(script, `#!/bin/sh\nprintf '%s' "$1" > "${dir}/seen"\nprintf 'half' > "$1"\nexit 3\n`, { mode: 0o755 });
  const res = await runCliOnTty(['suggest', '--save', '--expect', 'none'], { ...env, VISUAL: script });
  assert.notEqual(res.code, 0);
  assert.equal(existsSync(casesFile(state)), false);
  assert.equal(existsSync(path.dirname(await fsp.readFile(path.join(dir, 'seen'), 'utf8'))), false);
});

ttyTest('--save with an editor that leaves the file empty exits 2 and writes no case', async () => {
  const { state, env } = await sandbox();
  const editor = await fakeEditor('   ');
  const res = await runCliOnTty(['suggest', '--save', '--expect', 'none'], { ...env, VISUAL: editor.script });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(existsSync(casesFile(state)), false);
});

test('--save with an invalid --expect names the allowed slug characters', async () => {
  const { env } = await sandbox();
  const res = await runCliWithInput(['suggest', '--save', '--expect', 'Not A Slug!'], env, 'x');
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /--expect must be a slug \(letters, digits, \. _ @ : -\) or none/);
});

ttyTest('Ctrl+C while the editor is open does not kill the command: the editor ends, the case is saved and the temp dir is gone', async () => {
  const { state, env } = await sandbox();
  const dir = await tempDir('sv-sg-editor-');
  const script = path.join(dir, 'int.sh');
  // Ignores INT itself, then sends INT to its whole process group (what the terminal does on Ctrl+C) and finishes.
  await fsp.writeFile(script, `#!/bin/sh\ntrap '' INT\nprintf '%s' "$1" > "${dir}/seen"\nprintf 'after ctrl-c' > "$1"\nkill -INT 0\nsleep 0.3\nexit 0\n`, { mode: 0o755 });
  const res = await runCliOnTty(['suggest', '--save', '--expect', 'none'], { ...env, VISUAL: script });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal((await readCases(state))[0].q, 'after ctrl-c');
  assert.equal(existsSync(path.dirname(await fsp.readFile(path.join(dir, 'seen'), 'utf8'))), false, 'the temp dir is removed');
});

ttyTest('SIGTERM to the command while the editor is open removes the temp dir and exits 143', async () => {
  const { state, env } = await sandbox();
  const dir = await tempDir('sv-sg-editor-');
  const script = path.join(dir, 'term.sh');
  // The shell execs the editor, so its parent is the CLI: send it SIGTERM (no ps lookup, whose names differ by platform).
  await fsp.writeFile(script, `#!/bin/sh
printf '%s' "$1" > "${dir}/seen"
printf 'half written' > "$1"
kill -TERM "$PPID"
sleep 2
`, { mode: 0o755 });
  const res = await runCliOnTty(['suggest', '--save', '--expect', 'none'], { ...env, VISUAL: script });
  assert.equal(res.code, 143, res.stdout + res.stderr);
  assert.equal(existsSync(casesFile(state)), false);
  assert.equal(existsSync(path.dirname(await fsp.readFile(path.join(dir, 'seen'), 'utf8'))), false, 'the temp dir is removed');
});

// ---- --calibrate --retrieval / --rule (spec §10) ----
// Every run below is a child process over a temporary HEADJACK_HOME with no HEADJACK_URL. Any run that sets
// AI_GATEWAY_API_KEY also gets a fetch preload, so no test can reach the real Gateway: the preload answers every call with
// one 1536-dimension vector per input and appends { url, input } to the file named by FETCH_LOG.

const FETCH_PRELOAD = `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const input = JSON.parse(init.body).input;
  appendFileSync(process.env.FETCH_LOG, JSON.stringify({ url: String(url), input }) + '\\n');
  return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, ...Array(1535).fill(0)] })) });
};
`;

const KEY = { AI_GATEWAY_API_KEY: 'test-fixture' };
const cronRows = (lang, total, nulls) => Array.from({ length: total }, (_, i) => (i < nulls
  ? { q: `which bird sings loudest at dawn in the garden ${lang} ${i}`, slug: null, lang }
  : { q: `please run my recurring jobs periodically using cron on server ${lang} ${i}`, slug: 'zq-helper', lang }));
const EVAL_SET = [...cronRows('en', 20, 8), ...cronRows('es', 20, 8)];

// A vault whose chunks all carry a vector (so the meta allow-lists are valid), plus the eval set and a fetch log.
// `vectors`: true gives every chunk 1-4 a vector, 'empty' leaves chunk_vecs created but empty, false never creates it.
async function calibrationBox({ extraChunks = 0, vectors = true } = {}) {
  const box = await sandbox();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir: box.state, DatabaseSync, allowExtension: true });
  const repo = createSqliteRepo(db);
  await repo.publish(skill('zq-helper', 'Run recurring jobs periodically with cron', 'Sets up a crontab for recurring jobs.'));
  await repo.publish(skill('gardening', 'Grow tomatoes', 'Water daily.'));
  if (vectors !== false) assert.equal(loadVec(db), true, 'vendored sqlite-vec must load');
  // publish stores no chunk rows without embeddings: add each skill's frontmatter chunk (`name: description`, as the
  // backfill stores it) and a body chunk by hand, so chunks 1-4 are the vault's whole chunk set.
  const addChunk = db.prepare('insert into chunks (skill_id, version_id, text, kind) values (?, ?, ?, ?)');
  for (const s of db.prepare('select id, name, description, current_version_id from skills order by id').all()) {
    addChunk.run(s.id, s.current_version_id, `${s.name}: ${s.description}`, 'content');
    addChunk.run(s.id, s.current_version_id, `body of ${s.name}`, 'content');
  }
  if (extraChunks) {
    db.exec('BEGIN');
    for (let i = 0; i < extraChunks; i++) addChunk.run(2, 2, 'filler', 'content');
    db.exec('COMMIT');
  }
  const put = vectors === true ? db.prepare('insert into chunk_vecs (rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)') : null;
  for (const c of vectors === true ? db.prepare('select id, skill_id, version_id from chunks where id <= 4 order by id').all() : []) {
    put.run(BigInt(c.id), JSON.stringify([c.id % 2, (c.id + 1) % 2, ...Array(1534).fill(0)]), BigInt(c.skill_id), BigInt(c.version_id));
  }
  db.close();
  await fsp.mkdir(path.join(box.state, 'suggest'), { recursive: true });
  await fsp.writeFile(path.join(box.state, 'suggest', 'eval.json'), JSON.stringify(EVAL_SET));
  const log = path.join(await tempDir('sv-sg-fetchlog-'), 'fetch.jsonl');
  const fetched = async () => (existsSync(log) ? (await fsp.readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...box, log, fetched, env: { ...box.env, FETCH_LOG: log } };
}

const calibrateJson = async (box, args, extraEnv = {}) => {
  const res = await runCli(['suggest', '--calibrate', '--mode', 'local', ...args, '--json'], { ...box.env, ...extraEnv }, { preload: FETCH_PRELOAD });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  return { res, out: JSON.parse(res.stdout) };
};
const pairOf = (out, retrieval, ruleName) => out.pairs.find((p) => p.retrieval === retrieval && p.ruleName === ruleName);

localTest('the default fts x gap run keeps the previous per-language metrics, counts and recommended thresholds (the new fields are excluded from the comparison)', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, []);
  // The previous CLI: hybrid deps, no key, so every row fell back to full text.
  const ctx = { env: { ...box.env }, dir: box.state, home: box.home, cwd: process.cwd() };
  const config = await loadSuggestConfig(box.state);
  const before = await calibrate({
    rows: EVAL_SET, mode: 'local', config, cwd: ctx.cwd, home: ctx.home,
    depsFor: (sessionId) => suggestDeps({ ctx, config, sessionId, purpose: 'eval', migrate: true, hybrid: true }),
  });
  const counts = (report) => Object.fromEntries(Object.entries(report.current).map(([lang, m]) => [lang, [m.precision, m.recall]]));
  const folded = (report) => Object.fromEntries(Object.entries(report.cv.perLang).map(([lang, l]) => [lang, [l.rows, l.train.precision, l.train.recall, l.heldOut.precision, l.heldOut.recall, l.folds.map((f) => f.chosen)]]));
  assert.deepEqual(counts(out), counts(before));
  assert.deepEqual(folded(out), folded(before));
  assert.deepEqual(out.cv.recommended, before.cv.recommended);
  assert.deepEqual(out.rule, before.rule);
  assert.deepEqual([out.mode, out.decisionMode, out.folds, out.seed, out.skipped, out.max], [before.mode, before.decisionMode, before.folds, before.seed, before.skipped, before.max]);
  assert.deepEqual(out.rows.map((r) => r.suggested), before.rows.map((r) => r.suggested));
  assert.equal(out.pairs.length, 1);
  assert.deepEqual([out.pairs[0].retrieval, out.pairs[0].ruleName], ['fts', 'gap']);
  assert.ok(Object.values(out.current).some((m) => m.recall.n > 0), 'the fixture must offer something');
});

localTest('fts with no key reports no fallback and is valid', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, ['--retrieval', 'fts']);
  const fts = pairOf(out, 'fts', 'gap');
  assert.equal(fts.valid, true);
  assert.equal(fts.reason, null);
  assert.equal(fts.fallbackRows, 0);
  assert.ok(fts.rows.every((r) => r.fallback === null));
  assert.deepEqual(await box.fetched(), []);
});

localTest('fts x rank-sim prints zero offers and says why (no vector signals)', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, ['--retrieval', 'fts', '--rule', 'rank-sim']);
  const pair = pairOf(out, 'fts', 'rank-sim');
  assert.equal(pair.valid, true);
  assert.equal(pair.decisionMode, 'hosted');
  assert.deepEqual(pair.current.en.precision, { pct: null, n: 0, d: 0 });
  assert.deepEqual(pair.current.en.recall, { pct: 0, n: 0, d: 12 });
  const gap = await calibrateJson(box, ['--retrieval', 'fts', '--rule', 'gap']);
  assert.ok(gap.out.current.en.recall.n > 0, 'while gap offers on the same candidates');
  assert.match(pair.note, /no vector signals/);
  const text = await runCli(['suggest', '--calibrate', '--mode', 'local', '--retrieval', 'fts', '--rule', 'rank-sim'], box.env, { preload: FETCH_PRELOAD });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /fts x rank-sim/);
  assert.match(text.stdout, /no vector signals/);
});

localTest('fts makes no embed call with a key present', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, ['--retrieval', 'fts'], KEY);
  assert.equal(pairOf(out, 'fts', 'gap').valid, true);
  assert.deepEqual(await box.fetched(), []);
});

localTest('hybrid pairs embed each prompt once across configurations', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, ['--retrieval', 'hybrid,hybrid-meta', '--rule', 'gap,rank-sim'], KEY);
  assert.equal(out.pairs.length, 4);
  for (const pair of out.pairs) assert.equal(pair.valid, true, `${pair.retrieval} x ${pair.ruleName}: ${pair.reason}`);
  const embedded = (await box.fetched()).flatMap((call) => call.input).sort();
  assert.deepEqual(embedded, EVAL_SET.map((r) => r.q).sort(), 'every prompt exactly once');
});

localTest('a rank-sim pair makes no hosted request', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, ['--retrieval', 'fts,hybrid', '--rule', 'rank-sim'], KEY);
  assert.equal(out.mode, 'local');
  assert.equal(out.decisionMode, 'hosted');
  assert.ok((await box.fetched()).every((call) => call.url.includes('/v1/embeddings')), 'only the embeddings endpoint is called');
  assert.ok((await box.fetched()).length > 0);
});

localTest('a missing vec library makes every hybrid pair invalid and fts still prints', async () => {
  const box = await calibrationBox();
  const { out, res } = await calibrateJson(box, ['--retrieval', 'fts,hybrid,hybrid-meta,hybrid-meta-tags'], { ...KEY, HEADJACK_VEC_PATH: '/missing-t7-vec' });
  const fts = pairOf(out, 'fts', 'gap');
  assert.equal(fts.valid, true);
  assert.ok(fts.current.en && fts.cv.recommended.en, 'fts is scored');
  for (const name of ['hybrid', 'hybrid-meta', 'hybrid-meta-tags']) {
    const pair = pairOf(out, name, 'gap');
    assert.equal(pair.valid, false, name);
    assert.equal(pair.reason, 'vec-unavailable', name);
    assert.equal(pair.current, undefined, `${name} is not scored`);
    assert.equal(pair.cv, undefined, `${name} is not scored`);
  }
  assert.deepEqual(await box.fetched(), [], 'an invalid pair embeds nothing');
  const text = await runCli(['suggest', '--calibrate', '--mode', 'local', '--retrieval', 'fts,hybrid'], { ...box.env, ...KEY, HEADJACK_VEC_PATH: '/missing-t7-vec' }, { preload: FETCH_PRELOAD });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /hybrid x gap[\s\S]*invalid: vec-unavailable/);
  assert.match(text.stdout, /fts x gap[\s\S]*precision/);
  void res;
});

for (const vectors of [false, 'empty']) {
  localTest(`a vault with the vec library but ${vectors === false ? 'no chunk_vecs table' : 'an empty chunk_vecs table'} makes every hybrid pair invalid and fts still prints`, async () => {
    const box = await calibrationBox({ vectors });
    const { out } = await calibrateJson(box, ['--retrieval', 'fts,hybrid,hybrid-meta,hybrid-meta-tags'], KEY);
    const fts = pairOf(out, 'fts', 'gap');
    assert.equal(fts.valid, true);
    assert.ok(fts.current.en && fts.cv.recommended.en, 'fts is scored');
    for (const name of ['hybrid', 'hybrid-meta', 'hybrid-meta-tags']) {
      const pair = pairOf(out, name, 'gap');
      assert.equal(pair.valid, false, name);
      assert.equal(pair.reason, 'vec-unavailable', name);
      assert.equal(pair.current, undefined, `${name} is not scored`);
    }
    assert.deepEqual(await box.fetched(), [], 'an invalid pair embeds nothing');
    if (vectors === false) {
      const { DatabaseSync } = await runtimeCheck();
      const db = openVault({ dir: box.state, DatabaseSync });
      try {
        assert.equal(db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n, 0, 'the calibration does not create chunk_vecs');
      } finally { db.close(); }
    }
  });
}

localTest('an unset AI_GATEWAY_API_KEY reports no-key and invalidates hybrid pairs', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, ['--retrieval', 'fts,hybrid']);
  const hybrid = pairOf(out, 'hybrid', 'gap');
  assert.equal(hybrid.valid, false);
  assert.equal(hybrid.reason, 'no-key');
  assert.equal(hybrid.fallbackRows, EVAL_SET.length);
  assert.ok(hybrid.rows.every((r) => r.fallback === 'no-key'));
  assert.equal(hybrid.current, undefined);
  assert.equal(pairOf(out, 'fts', 'gap').valid, true);
  assert.deepEqual(await box.fetched(), []);
});

localTest('a pair above 4096 chunks prints invalid with its reason', async () => {
  const box = await calibrationBox({ extraChunks: 4100 });
  const { out } = await calibrateJson(box, ['--retrieval', 'fts,hybrid,hybrid-meta,hybrid-meta-tags'], KEY);
  assert.ok(out.chunkCount > 4096);
  for (const name of ['hybrid', 'hybrid-meta', 'hybrid-meta-tags']) {
    const pair = pairOf(out, name, 'gap');
    assert.deepEqual([pair.valid, pair.reason, pair.current], [false, 'chunk-count-above-4096', undefined], name);
  }
  assert.equal(pairOf(out, 'fts', 'gap').valid, true);
  assert.deepEqual(await box.fetched(), []);
  const text = await runCli(['suggest', '--calibrate', '--mode', 'local', '--retrieval', 'hybrid'], { ...box.env, ...KEY }, { preload: FETCH_PRELOAD });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /hybrid x gap[\s\S]*invalid: chunk-count-above-4096/);
});

localTest('a malformed sidecar invalidates the hybrid pairs and never throws', async () => {
  const box = await calibrationBox();
  await fsp.writeFile(path.join(box.state, 'eval-tag-chunks.json'), '{ not json');
  const { out } = await calibrateJson(box, ['--retrieval', 'fts,hybrid,hybrid-meta,hybrid-meta-tags'], KEY);
  for (const name of ['hybrid', 'hybrid-meta', 'hybrid-meta-tags']) {
    const pair = pairOf(out, name, 'gap');
    assert.deepEqual([pair.valid, pair.reason, pair.current], [false, 'invalid-sidecar', undefined], name);
  }
  assert.equal(pairOf(out, 'fts', 'gap').valid, true);
  assert.deepEqual(await box.fetched(), []);
});

localTest('--json carries sha256, seed, chunk count, fallback count and validity', async () => {
  const box = await calibrationBox();
  const { out } = await calibrateJson(box, ['--retrieval', 'fts,hybrid'], KEY);
  const expected = createHash('sha256').update(await fsp.readFile(path.join(box.state, 'suggest', 'eval.json'))).digest('hex');
  for (const pair of out.pairs) {
    assert.equal(pair.sha256, expected);
    assert.equal(pair.seed, 17);
    assert.equal(pair.folds, 5);
    assert.equal(pair.chunkCount, 4);
    assert.equal(pair.fallbackRows, 0);
    assert.equal(pair.valid, true);
    assert.equal(pair.reason, null);
  }
  assert.equal(out.sha256, expected);
  assert.equal(out.chunkCount, 4);
  assert.ok(!existsSync(path.join(box.state, 'config.json')), 'config.json is never written');
  assert.ok(!JSON.stringify(out).includes('recurring jobs'), 'the JSON carries no prompt text');
});

test('an unknown --retrieval value exits 2', async () => {
  const box = await sandbox();
  for (const args of [
    ['--retrieval', 'dense'], ['--retrieval', 'fts,dense'], ['--rule', 'strict'], ['--retrieval', ''], ['--rule', 'gap,'],
    ['--retrieval', 'fts', '--mode', 'hosted'], ['--rule', 'gap', '--mode', 'hosted'],
  ]) {
    const res = await runCli(['suggest', '--calibrate', ...args], box.env);
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /--retrieval|--rule/, args.join(' '));
  }
  for (const args of [['--retrieval', 'fts'], ['--rule', 'gap']]) {
    const res = await runCli(['suggest', ...args], box.env);
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.stderr, /--calibrate/);
  }
  assert.ok(!existsSync(path.join(box.state, 'config.json')));
});
