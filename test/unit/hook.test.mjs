// `headjack hook prompt|warmup` (spec §3.3, §3.8, §4.1, §12): runHook over a temporary state dir, with the hosted search
// injected where the transport must misbehave, and the spawned CLI for the process-level guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runHook } from '../../cli/hook.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { MIGRATIONS, openVault, vaultFile } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { readEvents } from '../../lib/suggest-log.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const PROMPT = 'please run my recurring jobs periodically using cron on the staging servers';
const SESSION = 'sess-0001';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

let sha = 0;
const skill = (slug, description, body) => ({
  manifest: {
    slug, name: slug, description, kind: 'skill', plugin_slug: null, tags: [], source: { kind: 'local' },
    sha256: String((sha += 1)).padStart(64, '0'), status: 'approved', review_notes: 'ok', scan_flags: [],
  },
  tarball: null,
  chunks: [{ text: body, kind: 'content' }],
});

// { home, dir }: a home with no Claude state and an empty state dir.
async function sandbox() {
  const home = await tempDir('sv-hook-home-');
  const dir = path.join(home, 'hj');
  await fsp.mkdir(dir, { recursive: true });
  return { home, dir };
}

async function seededSandbox() {
  const box = await sandbox();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir: box.dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  await repo.publish(skill('zq-helper', 'Run recurring jobs periodically with cron', 'Sets up a crontab for recurring jobs.'));
  await repo.publish(skill('gardening', 'Grow tomatoes', 'Water daily.'));
  db.close();
  return box;
}

const writeConfig = (dir, config) => fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
const enable = (dir, suggest = {}) => writeConfig(dir, { suggest: { enabled: true, ...suggest } });
const hostedConfig = (dir, extra = {}) => enable(dir, { hosted: true, url: 'https://headjack.example.invalid', ...extra });
const payload = (over = {}) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: '/nowhere', prompt: PROMPT, ...over });

const hook = (name, box, { stdin = payload(), ...rest } = {}) => runHook(name, { stdin, env: { HOME: box.home }, home: box.home, dir: box.dir, ...rest });
const sessionFile = (box, id = SESSION) => path.join(box.dir, 'suggest', 'sessions', `${id}.json`);
const hookLog = (box) => fsp.readFile(path.join(box.dir, 'suggest', 'hook.log'), 'utf8').catch(() => '');
const failure = (message = 'HTTP 503') => Object.assign(new Error(message), { failure: true });
const never = () => new Promise(() => {});

// ---- prompt: output ----

test('prompt: disabled prints nothing and writes nothing', async () => {
  const box = await seededSandbox();
  const out = await hook('prompt', box);
  assert.deepEqual(out, { stdout: '' });
  assert.equal(existsSync(path.join(box.dir, 'suggest')), false);
});

test('prompt: malformed stdin prints nothing and logs one hook.log line without the input', async () => {
  const box = await seededSandbox();
  await enable(box.dir);
  for (const stdin of ['{"prompt": "secret words here', 'not json at all secret', '[1,2]', '']) {
    assert.deepEqual(await hook('prompt', box, { stdin }), { stdout: '' });
  }
  const lines = (await hookLog(box)).trim().split('\n');
  assert.equal(lines.length, 4);
  assert.ok(!(await hookLog(box)).includes('secret'));
  assert.equal(((await fsp.stat(path.join(box.dir, 'suggest', 'hook.log'))).mode & 0o777), 0o600);
});

localTest('prompt: a match prints the hookSpecificOutput JSON with the fenced block, and the same prompt again prints nothing', async () => {
  const box = await seededSandbox();
  await enable(box.dir);
  const first = await hook('prompt', box);
  const parsed = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const context = parsed.hookSpecificOutput.additionalContext;
  assert.match(context, /^<headjack-suggestions note="/);
  assert.match(context, /- zq-helper — Run recurring jobs periodically with cron/);
  assert.match(context, /<\/headjack-suggestions>/);
  assert.match(context, /HEADJACK_MODE=local '.*cli\/headjack' add <slug> --to claude --session --source suggest/);
  assert.ok(!context.includes('gardening'));

  assert.deepEqual(await hook('prompt', box), { stdout: '' });

  // The run is logged without the prompt text.
  const runs = (await readEvents(box.dir)).filter((e) => e.type === 'run');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => [r.entry, r.session, r.mode, r.outcome]), [['hook', SESSION, 'local', 'suggested'], ['hook', SESSION, 'local', 'none']]);
  assert.ok(!JSON.stringify(runs).includes('recurring jobs periodically'));
  assert.equal(((await fsp.stat(sessionFile(box))).mode & 0o777), 0o600);
});

test('prompt: a hook session_id failing the id pattern writes no session file, and nothing is deduped', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir);
  const hostedSearch = async () => ({ candidates: [{ slug: 'zq-helper', name: 'zq-helper', description: 'Run recurring jobs', kind: 'skill', review: 'approved', similarity: 0.9, fts_rank: 1, vector_rank: 1 }], variant: 'a' });
  for (const id of ['../../evil', 'has space', 'x'.repeat(65), '', 7]) {
    const out = await hook('prompt', box, { stdin: payload({ session_id: id }), adapters: { hostedSearch } });
    assert.ok(out.stdout.includes('zq-helper'), `no output for session_id ${JSON.stringify(id)}`);
  }
  // Same invalid id twice: still printed (no dedupe).
  const again = await hook('prompt', box, { stdin: payload({ session_id: '../../evil' }), adapters: { hostedSearch } });
  assert.ok(again.stdout.includes('zq-helper'));
  assert.equal(existsSync(path.join(box.dir, 'suggest', 'sessions')), false);
  assert.equal(existsSync(path.join(box.dir, '..', 'evil.json')), false);
});

test('prompt: unknown hook names and skill-used print nothing', async () => {
  const box = await seededSandbox();
  await enable(box.dir);
  assert.deepEqual(await hook('nonsense', box), { stdout: '' });
  assert.deepEqual(await hook('skill-used', box), { stdout: '' });
  assert.deepEqual(await hook(undefined, box), { stdout: '' });
});

test('prompt: a malformed config is a no-op, logged once per session', async () => {
  const box = await sandbox();
  await writeConfig(box.dir, { suggest: { enabled: 'yes' } });
  assert.deepEqual(await hook('prompt', box), { stdout: '' });
  assert.deepEqual(await hook('prompt', box), { stdout: '' });
  assert.equal((await hookLog(box)).trim().split('\n').length, 1);
  assert.deepEqual(await hook('prompt', box, { stdin: payload({ session_id: 'other-1' }) }), { stdout: '' });
  assert.equal((await hookLog(box)).trim().split('\n').length, 2);
});

test('prompt: an exception anywhere prints nothing and logs a line without the prompt', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir);
  const hostedSearch = async () => { throw new TypeError(`boom ${PROMPT}`); };
  const out = await hook('prompt', box, { adapters: { hostedSearch } });
  assert.deepEqual(out, { stdout: '' });
  const log = await hookLog(box);
  assert.equal(log.trim().split('\n').length, 1);
  assert.ok(!log.includes('recurring jobs'));
  const runs = (await readEvents(box.dir)).filter((e) => e.type === 'run');
  assert.deepEqual(runs.map((r) => r.outcome), ['error']);
});

// ---- prompt: deadline ----

test('prompt: a hosted search that never resolves returns within deadlineMs.hosted + 100 ms and is aborted', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir, { deadlineMs: { hosted: 300 } });
  let signal;
  const hostedSearch = (args) => { signal = args.signal; return never(); };
  const started = Date.now();
  const out = await hook('prompt', box, { adapters: { hostedSearch } });
  const elapsed = Date.now() - started;
  assert.deepEqual(out, { stdout: '' });
  assert.ok(elapsed >= 250 && elapsed < 400, `took ${elapsed} ms`);
  assert.equal(signal.aborted, true);
  const runs = (await readEvents(box.dir)).filter((e) => e.type === 'run');
  assert.deepEqual(runs.map((r) => r.outcome), ['timeout']);
});

test('prompt: the deadline counts from t0, so time spent before runHook (process start, stdin, imports) is not extra', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir, { deadlineMs: { hosted: 400 } });
  let signal;
  const hostedSearch = (args) => { signal = args.signal; return never(); };
  const started = performance.now();
  // As if the process had been running for 300 ms before the hook started: 100 ms of the 400 ms budget are left.
  const out = await hook('prompt', box, { adapters: { hostedSearch }, t0: started - 300 });
  const elapsed = performance.now() - started;
  assert.deepEqual(out, { stdout: '' });
  assert.ok(elapsed >= 80 && elapsed < 250, `took ${elapsed} ms`);
  assert.equal(signal.aborted, true);
  const runs = (await readEvents(box.dir)).filter((e) => e.type === 'run');
  assert.deepEqual(runs.map((r) => r.outcome), ['timeout']);
  // latency_ms counts from the same instant, so it is about the budget, not the ~100 ms since runHook. A Node timer can
  // fire up to ~1 ms early on the performance.now() clock (libuv's loop clock is cached and whole-millisecond), hence 395.
  assert.ok(runs[0].latency_ms >= 395 && runs[0].latency_ms < 550, `latency_ms ${runs[0].latency_ms}`);
});

test('prompt: a result that arrives after the deadline is not printed or remembered', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir, { deadlineMs: { hosted: 200 } });
  const late = { candidates: [{ slug: 'zq-helper', name: 'zq-helper', description: 'Run recurring jobs', kind: 'skill', review: 'approved', similarity: 0.9, fts_rank: 1, vector_rank: 1 }], variant: 'a' };
  const hostedSearch = () => new Promise((resolve) => setTimeout(() => resolve(late), 400));
  const out = await hook('prompt', box, { adapters: { hostedSearch } });
  assert.deepEqual(out, { stdout: '' });
  await new Promise((r) => setTimeout(r, 400));
  const state = JSON.parse(await fsp.readFile(sessionFile(box), 'utf8').catch(() => '{}'));
  assert.deepEqual(state.slugs ?? [], []);
});

// ---- prompt: circuit breaker ----

function breakerHarness(box, behavior) {
  const calls = { n: 0 };
  const hostedSearch = (args) => { calls.n += 1; return behavior(args, calls.n); };
  let t = 1_000_000;
  const run = (opts = {}) => hook('prompt', box, { adapters: { hostedSearch }, now: () => t, ...opts });
  return { calls, run, at: (v) => { t = v; }, tick: (ms) => { t += ms; }, time: () => t };
}

test('breaker: two failures (a 503 and a timeout) open it for 10 minutes; after that it closes', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir, { deadlineMs: { hosted: 200 } });
  let mode = 'fail';
  const h = breakerHarness(box, (args, n) => {
    if (mode === 'hang') return never();
    if (mode === 'ok') return { candidates: [], variant: null };
    return n === 1 ? Promise.reject(failure('HTTP 503')) : never();
  });
  await h.run(); // 503
  assert.equal(h.calls.n, 1);
  await h.run(); // timeout (the second failure)
  assert.equal(h.calls.n, 2);
  const state = JSON.parse(await fsp.readFile(sessionFile(box), 'utf8'));
  assert.equal(state.openUntil, h.time() + 10 * MINUTE);

  mode = 'ok';
  h.tick(10 * MINUTE - 1);
  assert.deepEqual(await h.run(), { stdout: '' });
  assert.equal(h.calls.n, 2, 'still open one ms before the end');
  const runs = (await readEvents(box.dir)).filter((e) => e.type === 'run');
  assert.equal(runs.at(-1).outcome, 'skipped:breaker');

  h.tick(1);
  await h.run();
  assert.equal(h.calls.n, 3, 'closed after 10 minutes');
  const closed = JSON.parse(await fsp.readFile(sessionFile(box), 'utf8'));
  assert.equal(closed.openUntil, null);
  assert.equal(closed.failures, 0);
});

test('breaker: skipped:no-post and usage-class errors do not count; a success resets the count', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir);
  const script = [
    () => ({ outcome: 'skipped:no-post' }),
    () => Promise.reject(Object.assign(new Error('not logged in'), { failure: false })),
    () => Promise.reject(Object.assign(new Error('not logged in'), { failure: false })),
    () => Promise.reject(failure()),
    () => ({ candidates: [], variant: null }), // success between: resets
    () => Promise.reject(failure()),
    () => ({ candidates: [], variant: null }),
  ];
  const h = breakerHarness(box, (args, n) => script[n - 1]());
  for (let i = 0; i < script.length; i += 1) await h.run();
  assert.equal(h.calls.n, script.length, 'the adapter ran every time: the breaker never opened');
  const state = JSON.parse(await fsp.readFile(sessionFile(box), 'utf8'));
  assert.equal(state.openUntil, null);
});

test('breaker: failures in one session do not open it for another', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir);
  const h = breakerHarness(box, () => Promise.reject(failure()));
  await h.run();
  await h.run();
  assert.equal(h.calls.n, 2);
  await h.run();
  assert.equal(h.calls.n, 2, 'open for sess-0001');
  await h.run({ stdin: payload({ session_id: 'sess-0002' }) });
  assert.equal(h.calls.n, 3);
});

test('breaker: a dedupe-only update keeps the breaker state in the same file', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir);
  const one = { candidates: [{ slug: 'zq-helper', name: 'zq-helper', description: 'Run recurring jobs', kind: 'skill', review: 'approved', similarity: 0.9, fts_rank: 1, vector_rank: 1 }], variant: 'a' };
  let n = 0;
  const h = breakerHarness(box, () => { n += 1; return n === 1 ? Promise.reject(failure()) : one; });
  await h.run();
  const out = await h.run();
  assert.ok(out.stdout.includes('zq-helper'));
  const state = JSON.parse(await fsp.readFile(sessionFile(box), 'utf8'));
  assert.deepEqual(state.slugs, ['zq-helper']);
  assert.equal(state.failures, 0, 'the success reset the count');
});

// ---- prompt: Review Focus 4 ----

localTest('prompt: a vault held under an exclusive lock gives skipped:busy, no output, within 1,000 ms', async () => {
  const box = await seededSandbox();
  await enable(box.dir);
  const { DatabaseSync } = await runtimeCheck();
  const holder = new DatabaseSync(vaultFile(box.dir));
  holder.exec('PRAGMA locking_mode = EXCLUSIVE');
  holder.exec('BEGIN IMMEDIATE');
  holder.exec("insert into sources (kind, url) values ('local', 'hook-lock-probe')");
  const started = performance.now();
  let out;
  try {
    out = await hook('prompt', box);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  const elapsed = performance.now() - started;
  assert.deepEqual(out, { stdout: '' });
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  const runs = (await readEvents(box.dir)).filter((e) => e.type === 'run');
  assert.deepEqual(runs.map((r) => r.outcome), ['skipped:busy']);
  // A busy vault is not a breaker failure.
  const state = JSON.parse(await fsp.readFile(sessionFile(box), 'utf8').catch(() => '{}'));
  assert.ok(!state.openUntil);
});

localTest('prompt: a vault.db that is not a database gives no output, an error run and one hook.log line without the prompt', async () => {
  const box = await sandbox();
  await enable(box.dir);
  await fsp.writeFile(vaultFile(box.dir), Buffer.from('these are my notes, not a database\n'.repeat(40)));
  assert.deepEqual(await hook('prompt', box), { stdout: '' });
  const runs = (await readEvents(box.dir)).filter((e) => e.type === 'run');
  assert.deepEqual(runs.map((r) => r.outcome), ['error']);
  const log = await fsp.readFile(path.join(box.dir, 'suggest', 'hook.log'), 'utf8');
  assert.equal(log.trim().split('\n').length, 1);
  assert.ok(!log.includes('recurring jobs'));
  // A damaged vault is not a transport failure: the breaker stays closed.
  const state = JSON.parse(await fsp.readFile(sessionFile(box), 'utf8').catch(() => '{}'));
  assert.ok(!state.openUntil && !state.failures);
});

// ---- warmup ----

localTest('warmup: local + enabled + vault present migrates it', async () => {
  const box = await seededSandbox();
  await enable(box.dir);
  const { DatabaseSync } = await runtimeCheck();
  const version = () => { const db = new DatabaseSync(vaultFile(box.dir)); try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); } };
  const before = version();
  MIGRATIONS.push('create table hook_warmup_probe (x integer)');
  try {
    assert.deepEqual(await hook('warmup', box, { stdin: '' }), { stdout: '' });
    assert.equal(version(), before + 1);
  } finally {
    MIGRATIONS.pop();
  }
});

test('warmup: local + enabled + no vault creates nothing', async () => {
  const box = await sandbox();
  await enable(box.dir);
  assert.deepEqual(await hook('warmup', box, { stdin: '' }), { stdout: '' });
  assert.equal(existsSync(vaultFile(box.dir)), false);
});

test('warmup: hosted + enabled runs one search with purpose warmup', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir);
  const calls = [];
  const hostedSearch = async (args) => { calls.push(args); return { candidates: [], variant: null }; };
  assert.deepEqual(await hook('warmup', box, { stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION }), adapters: { hostedSearch } }), { stdout: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'warmup');
  assert.equal(typeof calls[0].query, 'string');
  assert.ok(calls[0].query.length > 0);
});

test('warmup: disabled does nothing at all', async () => {
  const box = await seededSandbox();
  const calls = [];
  const hostedSearch = async (args) => { calls.push(args); return { candidates: [] }; };
  const stale = sessionFile(box, 'old-1');
  await fsp.mkdir(path.dirname(stale), { recursive: true });
  await fsp.writeFile(stale, '{"slugs":[]}');
  const old = new Date(Date.now() - 48 * HOUR);
  await fsp.utimes(stale, old, old);
  assert.deepEqual(await hook('warmup', box, { stdin: '', adapters: { hostedSearch } }), { stdout: '' });
  assert.equal(calls.length, 0);
  assert.equal(existsSync(stale), true);
});

test('warmup: prunes sessions older than 24 hours and keeps newer ones', async () => {
  const box = await sandbox();
  await enable(box.dir);
  const dirOf = path.join(box.dir, 'suggest', 'sessions');
  await fsp.mkdir(dirOf, { recursive: true });
  const t = Date.now();
  for (const [name, age] of [['old-1', 25 * HOUR], ['old-2', 48 * HOUR], ['new-1', 23 * HOUR], ['new-2', 0]]) {
    const f = path.join(dirOf, `${name}.json`);
    await fsp.writeFile(f, '{"slugs":[]}');
    const when = new Date(t - age);
    await fsp.utimes(f, when, when);
  }
  await hook('warmup', box, { stdin: '', now: () => t });
  assert.deepEqual((await fsp.readdir(dirOf)).sort(), ['new-1.json', 'new-2.json']);
});

test('warmup: a failing hosted search prints nothing and logs one line', async () => {
  const box = await sandbox();
  await hostedConfig(box.dir);
  const hostedSearch = async () => { throw failure('HTTP 503'); };
  assert.deepEqual(await hook('warmup', box, { stdin: '', adapters: { hostedSearch } }), { stdout: '' });
  assert.equal((await hookLog(box)).trim().split('\n').length, 1);
});

// ---- skill-used ----

const toolPayload = (skill, over = {}) => JSON.stringify({
  hook_event_name: 'PostToolUse', session_id: SESSION, cwd: '/nowhere', tool_name: 'Skill', tool_input: { skill }, ...over,
});
const invokes = async (box) => (await readEvents(box.dir)).filter((e) => e.type === 'invoke');
const writeSettings = async (box, enabledPlugins) => {
  await fsp.mkdir(path.join(box.home, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(box.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
};

localTest('skill-used: a Skill tool call writes one invoke event with the mapped vault slug', async () => {
  const box = await seededSandbox();
  const out = await hook('skill-used', box, { stdin: toolPayload('zq-helper'), now: () => Date.parse('2026-10-17T10:00:00Z') });
  assert.deepEqual(out, { stdout: '' });
  assert.deepEqual(await invokes(box), [{ type: 'invoke', session: SESSION, at: '2026-10-17T10:00:00.000Z', skill: 'zq-helper', slug: 'zq-helper' }]);
  assert.equal(existsSync(sessionFile(box)), false, 'the invoke event is log-only: no session file');
});

localTest('skill-used: a <plugin>:<skill> name maps through the vault and enabledPlugins', async () => {
  const box = await seededSandbox();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir: box.dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  await repo.publish(skill('vercel@a:flags-sdk', 'Flags', 'Use flags.'));
  await repo.publish(skill('vercel@b:flags-sdk', 'Flags', 'Use flags.'));
  db.close();
  await hook('skill-used', box, { stdin: toolPayload('vercel:flags-sdk') });
  await writeSettings(box, { 'vercel@b': true });
  await hook('skill-used', box, { stdin: toolPayload('vercel:flags-sdk') });
  assert.deepEqual((await invokes(box)).map((e) => [e.skill, e.slug]), [['vercel:flags-sdk', null], ['vercel:flags-sdk', 'vercel@b:flags-sdk']]);
});

localTest('skill-used: a skill that is not in the vault is logged with slug null', async () => {
  const box = await seededSandbox();
  await hook('skill-used', box, { stdin: toolPayload('not-in-the-vault') });
  assert.deepEqual((await invokes(box)).map((e) => [e.skill, e.slug]), [['not-in-the-vault', null]]);
});

test('skill-used: a missing vault leaves slug null and is never created', async () => {
  const box = await sandbox();
  await hook('skill-used', box, { stdin: toolPayload('zq-helper') });
  assert.deepEqual((await invokes(box)).map((e) => [e.skill, e.slug]), [['zq-helper', null]]);
  assert.equal(existsSync(vaultFile(box.dir)), false);
});

test('skill-used: an invalid session id is logged with session null', async () => {
  const box = await sandbox();
  for (const session_id of ['../evil', 'a b', '', 7, undefined]) await hook('skill-used', box, { stdin: toolPayload('zq-helper', { session_id }) });
  assert.deepEqual((await invokes(box)).map((e) => e.session), [null, null, null, null, null]);
  assert.equal(existsSync(path.join(box.dir, 'suggest', 'sessions')), false);
});

test('skill-used: other tools, other shapes and garbage write nothing', async () => {
  const box = await seededSandbox();
  for (const stdin of [
    toolPayload('zq-helper', { tool_name: 'Bash' }),
    toolPayload('zq-helper', { tool_name: undefined }),
    JSON.stringify({ tool_name: 'Skill', tool_input: {} }),
    JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 5 } }),
    JSON.stringify({ tool_name: 'Skill', tool_input: { skill: '' } }),
    JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'x'.repeat(500) } }),
    JSON.stringify({ tool_name: 'Skill' }),
    '{{{', '[]', '',
  ]) assert.deepEqual(await hook('skill-used', box, { stdin }), { stdout: '' });
  assert.deepEqual(await readEvents(box.dir), []);
});

test('skill-used: logs the skill name and never the arguments, and works with suggestions disabled', async () => {
  const box = await sandbox();
  await hook('skill-used', box, { stdin: toolPayload('zq-helper', { tool_input: { skill: 'zq-helper', args: 'SECRET-PROMPT-TEXT' } }) });
  const raw = await fsp.readFile(path.join(box.dir, 'suggest', 'log.jsonl'), 'utf8');
  assert.equal(raw.includes('SECRET-PROMPT-TEXT'), false);
  assert.equal((await invokes(box)).length, 1);
});

// ---- the spawned process ----

function runCli(args, { env, stdin = '' }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('node', [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

localTest('cli: hook prompt prints the JSON and exits 0; garbage stdin and unknown hooks print nothing and exit 0', async () => {
  const box = await seededSandbox();
  await enable(box.dir);
  const env = { HOME: box.home, HEADJACK_HOME: box.dir };
  const res = await runCli(['hook', 'prompt'], { env, stdin: payload() });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(res.stderr, '');

  const bad = await runCli(['hook', 'prompt'], { env, stdin: '{{{' });
  assert.deepEqual([bad.code, bad.stdout, bad.stderr], [0, '', '']);
  const unknown = await runCli(['hook', 'bogus'], { env, stdin: payload() });
  assert.deepEqual([unknown.code, unknown.stdout, unknown.stderr], [0, '', '']);
  const none = await runCli(['hook'], { env, stdin: '' });
  assert.deepEqual([none.code, none.stdout, none.stderr], [0, '', '']);
});

test('cli: a relative HEADJACK_HOME does not make the hook fail', async () => {
  const box = await sandbox();
  const res = await runCli(['hook', 'prompt'], { env: { HOME: box.home, HEADJACK_HOME: 'relative/dir' }, stdin: payload() });
  assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', '']);
});

// A server that accepts connections and never answers: a stuck network call.
async function blackhole() {
  const sockets = new Set();
  const seen = { connections: 0 };
  const server = createServer(() => {});
  server.on('connection', (s) => { seen.connections += 1; sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

test('cli: the hook process exits within the deadline when the hosted server never answers', async () => {
  const box = await sandbox();
  const server = await blackhole();
  try {
    await hostedConfig(box.dir, { url: server.url, deadlineMs: { hosted: 300 } });
    const res = await runCli(['hook', 'prompt'], { env: { HOME: box.home, HEADJACK_HOME: box.dir, HEADJACK_TOKEN: 'key-1' }, stdin: payload() });
    assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', '']);
    assert.ok(res.ms < 300 + 1000, `took ${res.ms} ms (node startup included)`);
  } finally {
    server.close();
  }
});

test('cli: the hook process exits within the deadline when the credential refresh is stuck', async () => {
  const box = await sandbox();
  const server = await blackhole();
  try {
    await hostedConfig(box.dir, { url: server.url, deadlineMs: { hosted: 300 } });
    // An expired OAuth login: the bearer must refresh first, and the token endpoint never answers.
    await fsp.writeFile(path.join(box.dir, 'token'), JSON.stringify({
      kind: 'oauth', issuer: server.url, client_id: 'c', resource: `${server.url}/api`, email: 'a@b.c', access_token: 'old', refresh_token: 'r', expires_at: Date.now() - HOUR,
    }), { mode: 0o600 });
    const res = await runCli(['hook', 'prompt'], { env: { HOME: box.home, HEADJACK_HOME: box.dir }, stdin: payload() });
    assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', '']);
    assert.equal(res.signal, null);
    assert.ok(server.seen.connections >= 1, 'the refresh reached the issuer');
    assert.ok(res.ms < 300 + 1000, `took ${res.ms} ms (node startup included)`);
  } finally {
    server.close();
  }
});

localTest('prompt local path with a Gateway key never fetches or enables/loads extensions', async () => {
  const box = await seededSandbox();
  await enable(box.dir);
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw Error('hook must stay offline'); };
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const { DatabaseSync } = await runtimeCheck();
  const opens = [];
  const hybridOptions = [];
  let extensionAttempts = 0;
  const CheckedDatabase = function(file, options) {
    opens.push(options);
    const db = new DatabaseSync(file, options);
    return new Proxy(db, { get(target, key) {
      if (key === 'loadExtension') return () => { extensionAttempts++; throw Error('hook must not load vec'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    await hook('prompt', box, {
      env: { HOME: box.home, AI_GATEWAY_API_KEY: 'test-fixture' },
      adapters: { localSearch: args => {
        hybridOptions.push(args.hybrid);
        return localSearch({ ...args, DatabaseSync: CheckedDatabase });
      } },
    });
    assert.ok(opens.length > 0);
    assert.deepEqual(hybridOptions, [false]);
    assert.ok(opens.every(options => options?.allowExtension !== true), 'hook must not enable extensions');
    assert.equal(extensionAttempts, 0, 'hook must not load vec');
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = originalFetch; }
});
