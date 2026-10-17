// Outcomes and the report (spec §5.3): pure functions over fixture events, then the spawned CLI over a real log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.mjs';
import { appendEvent } from '../../lib/suggest-log.mjs';
import { outcomes, summarize, formatReport, WINDOW_MS } from '../../lib/suggest-report.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const MIN = 60_000;
const at = (min) => new Date(T0 + min * MIN).toISOString();

const cand = (slug, over = {}) => ({ slug, active: false, review: 'approved', passed: true, rejected_by: null, ...over });
const run = (min, over = {}) => ({
  type: 'run', entry: 'hook', session: 's1', at: at(min), mode: 'local', variant: 'local', latency_ms: 10, outcome: 'suggested',
  lang_guess: 'en', active_keys: [], candidates: [cand('zq-helper')], ...over,
});
const add = (min, slug, over = {}) => ({ type: 'add', session: 's1', at: at(min), slug, source: 'suggest', ...over });
const invoke = (min, skill, slug = skill, over = {}) => ({ type: 'invoke', session: 's1', at: at(min), skill, slug, ...over });

test('the window is 30 minutes', () => assert.equal(WINDOW_MS, 1_800_000));

test('a suggestion added 10 minutes later is a hit with added only', () => {
  const o = outcomes([run(0), add(10, 'zq-helper')]);
  assert.equal(o.hits.length, 1);
  assert.deepEqual([o.hits[0].slug, o.hits[0].session, o.hits[0].added, o.hits[0].invoked], ['zq-helper', 's1', true, false]);
  assert.deepEqual([o.ignored.length, o.missed.length], [0, 0]);
});

test('add and invoke of a suggestion are one hit with both', () => {
  const o = outcomes([run(0), add(5, 'zq-helper'), invoke(8, 'zq-helper')]);
  assert.equal(o.hits.length, 1);
  assert.deepEqual([o.hits[0].added, o.hits[0].invoked], [true, true]);
  assert.equal(o.missed.length, 0);
});

test('an invoke alone is a hit with invoked only', () => {
  const o = outcomes([run(0), invoke(3, 'zq-helper')]);
  assert.deepEqual([o.hits[0].added, o.hits[0].invoked], [false, true]);
});

test('nothing within 30 minutes is ignored', () => {
  const o = outcomes([run(0)]);
  assert.deepEqual([o.hits.length, o.ignored.length, o.missed.length], [0, 1, 0]);
  assert.equal(o.ignored[0].slug, 'zq-helper');
});

test('the window is inclusive at 30 minutes and ends after it', () => {
  assert.equal(outcomes([run(0), add(30, 'zq-helper')]).hits.length, 1);
  const late = outcomes([run(0), add(31, 'zq-helper')]);
  assert.deepEqual([late.hits.length, late.ignored.length, late.missed.length], [0, 1, 1]);
  assert.deepEqual([late.missed[0].slug, late.missed[0].at], ['zq-helper', at(31)]);
});

test('an add of a slug nobody suggested is a miss with its rank in the last run', () => {
  const o = outcomes([run(0, { candidates: [cand('first'), cand('second', { rejected_by: 'max' }), cand('third', { rejected_by: 'rule' })] }), add(5, 'third')]);
  assert.equal(o.missed.length, 1);
  assert.deepEqual([o.missed[0].slug, o.missed[0].session, o.missed[0].at, o.missed[0].rankInLastRun], ['third', 's1', at(5), 3]);
  assert.equal(o.ignored.length, 1, 'first stays ignored');
});

test('a miss that was not a candidate has a null rank', () => {
  const o = outcomes([run(0), add(5, 'elsewhere')]);
  assert.deepEqual([o.missed[0].slug, o.missed[0].rankInLastRun], ['elsewhere', null]);
});

test('an invoke of an inactive unsuggested slug is a miss with its rank', () => {
  const o = outcomes([run(0, { candidates: [cand('first'), cand('other', { rejected_by: 'rule' })] }), invoke(4, 'other')]);
  assert.deepEqual([o.missed.length, o.missed[0].slug, o.missed[0].rankInLastRun], [1, 'other', 2]);
});

test('already-active slugs are never misses: invoke or add, by slug or by plugin key', () => {
  const keys = ['brainstorming', 'ops@market'];
  const o = outcomes([
    run(0, { active_keys: keys }),
    invoke(1, 'brainstorming'),
    add(2, 'brainstorming'),
    invoke(3, 'ops:deploy', 'ops@market:deploy'),
    add(4, 'ops@market:deploy'),
  ]);
  assert.equal(o.missed.length, 0);
});

test('a candidate marked active in the last run is not a miss', () => {
  const o = outcomes([run(0, { candidates: [cand('held', { active: true, rejected_by: 'active' })] }), invoke(2, 'held')]);
  assert.equal(o.missed.length, 0);
});

test('active is read from the last run at or before the event, skipping runs that did not read state', () => {
  const o = outcomes([
    run(0, { active_keys: [], candidates: [] , outcome: 'none' }),
    run(10, { outcome: 'skipped:short', active_keys: [], candidates: [], lang_guess: null }),
    invoke(12, 'x'),
    run(20, { active_keys: ['x'], candidates: [], outcome: 'none' }),
    invoke(25, 'y'),
  ]);
  assert.deepEqual(o.missed.map((m) => m.slug), ['x', 'y'], 'x was inactive when invoked; y is a miss too');
  const again = outcomes([run(0, { active_keys: ['x'], outcome: 'none', candidates: [] }), run(10, { outcome: 'skipped:short', active_keys: [], candidates: [], lang_guess: null }), invoke(12, 'x')]);
  assert.equal(again.missed.length, 0, 'the skipped run does not make x look inactive');
});

test('a session where the hook did not run scores no misses', () => {
  const o = outcomes([run(0, { entry: 'manual' }), add(5, 'elsewhere')]);
  assert.equal(o.missed.length, 0);
});

test('an event before any run of its session is not scored', () => {
  const o = outcomes([add(1, 'elsewhere'), run(5)]);
  assert.equal(o.missed.length, 0);
});

test('a miss counts once per session and slug; an invoke after the add does not double count', () => {
  const o = outcomes([run(0), add(2, 'elsewhere'), invoke(3, 'elsewhere'), invoke(50, 'elsewhere')]);
  assert.equal(o.missed.length, 1);
  assert.equal(o.missed[0].at, at(2));
});

test('an invoke long after a suggested add is not a miss', () => {
  const o = outcomes([run(0), add(10, 'zq-helper'), invoke(55, 'zq-helper')]);
  assert.deepEqual([o.hits.length, o.missed.length], [1, 0]);
});

test('runs and events without a session are excluded', () => {
  const o = outcomes([run(0, { session: null }), run(1, { session: undefined }), add(2, 'zq-helper', { session: null }), invoke(3, 'z', 'z', { session: null })]);
  assert.deepEqual([o.hits.length, o.ignored.length, o.missed.length], [0, 0, 0]);
});

test('sessions do not mix', () => {
  const o = outcomes([run(0), add(5, 'zq-helper', { session: 's2' })]);
  assert.deepEqual([o.hits.length, o.ignored.length], [0, 1]);
});

test('only candidates without a rejection are suggestions', () => {
  const o = outcomes([run(0, { candidates: [cand('a'), cand('b', { rejected_by: 'seen' }), cand('c', { passed: false, rejected_by: 'rule' })] })]);
  assert.deepEqual(o.ignored.map((i) => i.slug), ['a']);
});

test('hosted invokes (slug null) map against the session candidates and count as hits', () => {
  const o = outcomes([
    run(0, { mode: 'hosted', candidates: [cand('ops@market:deploy')] }),
    invoke(4, 'ops:deploy', null),
  ]);
  assert.deepEqual([o.hits.length, o.hits[0].invoked, o.missed.length], [1, true, 0]);
});

test('an unmapped hosted invoke is never counted', () => {
  const o = outcomes([run(0, { mode: 'hosted' }), invoke(4, 'unknown:thing', null)]);
  assert.deepEqual([o.hits.length, o.missed.length, o.ignored.length], [0, 0, 1]);
});

test('hits and ignored carry entry, mode and lang_guess; runs with a null lang_guess group as n/a', () => {
  const o = outcomes([run(0, { entry: 'manual', lang_guess: null, mode: 'hosted' })]);
  assert.deepEqual([o.ignored[0].entry, o.ignored[0].mode, o.ignored[0].lang_guess], ['manual', 'hosted', 'n/a']);
});

test('--since style cutoff keeps earlier events as context but drops earlier outcomes', () => {
  const since = T0 + 5 * MIN;
  const o = outcomes([run(0), add(10, 'zq-helper'), run(20, { candidates: [cand('late')] })], { since });
  assert.deepEqual(o.hits, [], 'the run before the cutoff is not reported');
  assert.deepEqual(o.ignored.map((i) => i.slug), ['late']);
  assert.equal(o.missed.length, 0, 'the add was a hit, not a miss');
});

test('summarize groups by entry, mode and lang_guess with precision n/d', () => {
  const events = [];
  // 12 hook/local/en suggestions: 10 added, 2 ignored. Distinct sessions.
  for (let i = 0; i < 12; i += 1) {
    events.push(run(0, { session: `h${i}`, candidates: [cand('zq-helper')] }));
    if (i < 10) events.push(add(5, 'zq-helper', { session: `h${i}` }));
  }
  events.push(run(0, { session: 'm1', entry: 'manual', lang_guess: 'es' }));
  events.push(run(0, { session: 'm2', entry: 'manual', lang_guess: 'es', outcome: 'none', candidates: [] }));
  events.push(run(0, { session: 'k1', outcome: 'skipped:short', lang_guess: null, candidates: [], active_keys: [] }));
  events.push(run(0, { session: null }));
  const rows = summarize(outcomes(events), events);
  const hook = rows.find((r) => r.entry === 'hook' && r.lang_guess === 'en');
  assert.deepEqual([hook.mode, hook.runs, hook.hits, hook.ignored], ['local', 12, 10, 2]);
  assert.deepEqual(hook.precision, { pct: 83, n: 10, d: 12 });
  const manual = rows.find((r) => r.entry === 'manual');
  assert.deepEqual([manual.lang_guess, manual.runs, manual.hits, manual.ignored], ['es', 2, 0, 1]);
  assert.deepEqual(manual.precision, { pct: 0, n: 0, d: 1 });
  const skipped = rows.find((r) => r.lang_guess === 'n/a');
  assert.deepEqual([skipped.runs, skipped.hits, skipped.ignored, skipped.precision], [1, 0, 0, { pct: null, n: 0, d: 0 }]);
  assert.equal(rows.reduce((n, r) => n + r.runs, 0), 15, 'the run without a session is excluded');
});

test('formatReport prints precision with raw counts, per-entry rows and the misses', () => {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    events.push(run(0, { session: `h${i}` }));
    if (i < 10) events.push(add(5, 'zq-helper', { session: `h${i}` }));
  }
  events.push(add(6, 'elsewhere', { session: 'h0' }));
  const o = outcomes(events);
  const text = formatReport(summarize(o, events), o, { sinceLabel: '7d' });
  assert.match(text, /83% \(10\/12\)/);
  assert.match(text, /^hook +local +en /m);
  assert.match(text, /since 7d/);
  assert.match(text, /^missed \(1\)/m);
  assert.match(text, /elsewhere/);
});

test('formatReport prints n/a when nothing was decided and says so with no misses', () => {
  const events = [run(0, { outcome: 'none', candidates: [] })];
  const o = outcomes(events);
  const text = formatReport(summarize(o, events), o, {});
  assert.match(text, /n\/a \(0\/0\)/);
  assert.match(text, /missed \(0\)/);
});

test('formatReport never prints a slug that fails the vault pattern', () => {
  const events = [run(0, { candidates: [cand('bad slug\u001b[31m')] }), add(2, 'evil\nslug')];
  const o = outcomes(events);
  const text = formatReport(summarize(o, events), o, {});
  assert.doesNotMatch(text, /\u001b/);
  assert.doesNotMatch(text, /evil/);
  assert.match(text, /<invalid slug>/);
});

// ---- the CLI ----

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

async function sandboxWith(events) {
  const home = await tempDir('sv-rp-home-');
  const state = await tempDir('sv-rp-state-');
  for (const e of events) await appendEvent(state, e);
  return { home, state, env: { HOME: home, HEADJACK_HOME: state } };
}

const nowMinus = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;

test('suggest --report prints the text report from the log', async () => {
  const { env } = await sandboxWith([
    run(0, { at: nowMinus(2 * DAY), session: 'a' }), add(1, 'zq-helper', { at: nowMinus(2 * DAY - 5 * MIN), session: 'a' }),
    run(0, { at: nowMinus(1 * DAY), session: 'b' }),
  ]);
  const res = await runCli(['suggest', '--report'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /50% \(1\/2\)/);
  assert.match(res.stdout, /missed \(0\)/);
});

test('suggest --report --json prints the outcomes and rows', async () => {
  const { env } = await sandboxWith([run(0, { at: nowMinus(DAY), session: 'a' })]);
  const res = await runCli(['suggest', '--report', '--json'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.window_ms, WINDOW_MS);
  assert.equal(out.ignored.length, 1);
  assert.equal(out.rows[0].entry, 'hook');
  assert.deepEqual(out.missed, []);
});

test('suggest --report --since 7d leaves out older sessions', async () => {
  const { env } = await sandboxWith([
    run(0, { at: nowMinus(10 * DAY), session: 'old' }),
    run(0, { at: nowMinus(1 * DAY), session: 'new' }),
  ]);
  const res = await runCli(['suggest', '--report', '--since', '7d', '--json'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.ignored.map((i) => i.session), ['new']);
  assert.equal(out.rows.reduce((n, r) => n + r.runs, 0), 1);
});

test('suggest --report with no log prints an empty report', async () => {
  const { env } = await sandboxWith([]);
  const res = await runCli(['suggest', '--report'], env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /no runs/);
});

test('bad --report combinations exit 2', async () => {
  const { env } = await sandboxWith([]);
  for (const args of [
    ['suggest', '--report', 'some text'],
    ['suggest', '--report', '--enable'],
    ['suggest', '--report', '--since', '1w'],
    ['suggest', '--since', '7d'],
  ]) {
    const res = await runCli(args, env);
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /^headjack: /);
  }
  const bad = await runCli(['suggest', '--report', '--since', '1w'], env);
  assert.match(bad.stderr, /--since/);
});
