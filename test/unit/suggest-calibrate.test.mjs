// The calibration runner (spec §10): the eval set and its minimums, precision / recall / latency per language, the
// seeded 5-fold cross-validation, and `headjack suggest --calibrate` end to end. Invented fixtures only.
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
import { MIGRATIONS, openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { loadSuggestConfig } from '../../lib/suggest-config.mjs';
import { DEFAULT_RULE } from '../../lib/suggest-rule.mjs';
import { suggestDeps } from '../../cli/suggest-deps.mjs';
import {
  loadEvalSet, checkMinimums, metrics, assignFolds, buildGrid, suggestedSlugs, crossValidate, calibrate, formatCalibration,
} from '../../lib/suggest-calibrate.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));

const rows = (lang, total, nulls) => Array.from({ length: total }, (_, i) => ({
  q: `${lang} prompt number ${i} about something`, slug: i < nulls ? null : `skill-${i}`, lang,
}));
const enough = () => [...rows('en', 20, 8), ...rows('es', 20, 8)];

// ---- the eval set ----

test('loadEvalSet reads <dir>/suggest/eval.json and rejects a malformed row', async () => {
  const dir = await tempDir('sv-cal-');
  await fsp.mkdir(path.join(dir, 'suggest'), { recursive: true });
  const file = path.join(dir, 'suggest', 'eval.json');
  await fsp.writeFile(file, JSON.stringify([{ q: 'one', slug: 'a', lang: 'en' }, { q: 'two', slug: null, lang: 'es' }]));
  assert.deepEqual(await loadEvalSet(dir), [{ q: 'one', slug: 'a', lang: 'en' }, { q: 'two', slug: null, lang: 'es' }]);
  await fsp.writeFile(file, JSON.stringify([{ q: 'one', slug: 'a', lang: 'fr' }]));
  await assert.rejects(loadEvalSet(dir), /row 1.*lang/);
  await fsp.writeFile(file, JSON.stringify([{ q: '', slug: 'a', lang: 'en' }]));
  await assert.rejects(loadEvalSet(dir), /row 1.*q/);
  await fsp.writeFile(file, JSON.stringify({ not: 'an array' }));
  await assert.rejects(loadEvalSet(dir), /array/);
  await fsp.rm(file);
  await assert.rejects(loadEvalSet(dir), /eval\.json/);
});

test('checkMinimums is empty at 20 rows and 8 nulls per language', () => {
  assert.deepEqual(checkMinimums(enough()), []);
});

test('checkMinimums lists what is missing: 19 Spanish rows need 1 more row', () => {
  const set = [...rows('en', 20, 8), ...rows('es', 19, 8)];
  assert.deepEqual(checkMinimums(set), ['es: need 1 more row']);
});

test('checkMinimums refuses 7 Spanish nulls and counts each language on its own', () => {
  assert.deepEqual(checkMinimums([...rows('en', 20, 8), ...rows('es', 20, 7)]), ['es: need 1 more slug: null row']);
  assert.deepEqual(checkMinimums([...rows('en', 22, 8), ...rows('es', 15, 3)]), ['es: need 5 more rows', 'es: need 5 more slug: null rows']);
  assert.deepEqual(checkMinimums([]), ['en: need 20 more rows', 'en: need 8 more slug: null rows', 'es: need 20 more rows', 'es: need 8 more slug: null rows']);
});

// ---- metrics ----

const result = (lang, slug, suggested, latency_ms = 10) => ({ lang, slug, suggested, latency_ms });

test('precision counts any suggestion on a null row as a false positive, and a wrong slug as one too', () => {
  const m = metrics([
    result('en', 'a', ['a']), // correct
    result('en', 'b', ['x']), // wrong slug
    result('en', null, ['y', 'z']), // two suggestions on a null row: two false positives
    result('en', null, []), // nothing suggested: no unit at all
  ]).en;
  assert.deepEqual(m.precision, { pct: 25, n: 1, d: 4 });
  assert.deepEqual(m.recall, { pct: 50, n: 1, d: 2 });
});

test('recall counts a row once when its slug is among several suggestions, and a missing answer as a miss', () => {
  const m = metrics([result('es', 'a', ['b', 'a']), result('es', 'c', []), result('es', null, [])]).es;
  assert.deepEqual(m.recall, { pct: 50, n: 1, d: 2 });
  assert.deepEqual(m.precision, { pct: 50, n: 1, d: 2 });
});

test('metrics keeps languages apart and gives nearest-rank p50 / p95 latency', () => {
  const lat = Array.from({ length: 20 }, (_, i) => result('en', 'a', ['a'], (i + 1) * 10));
  const m = metrics([...lat, result('es', 'b', ['b'], 7)]);
  assert.equal(m.en.p50, 100);
  assert.equal(m.en.p95, 190);
  assert.deepEqual(m.es.precision, { pct: 100, n: 1, d: 1 });
  assert.equal(m.es.p50, 7);
});

test('a language with nothing to divide has a null percentage, never NaN', () => {
  const m = metrics([result('en', null, [])]).en;
  assert.deepEqual(m.precision, { pct: null, n: 0, d: 0 });
  assert.deepEqual(m.recall, { pct: null, n: 0, d: 0 });
});

// ---- folds ----

test('fold assignment is identical across runs with seed 17, balanced and per language', () => {
  const set = [...rows('en', 23, 8), ...rows('es', 20, 8)];
  const a = assignFolds(set, { folds: 5, seed: 17 });
  const b = assignFolds(set, { folds: 5, seed: 17 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, assignFolds(set, { folds: 5, seed: 18 }));
  for (const lang of ['en', 'es']) {
    const sizes = [0, 1, 2, 3, 4].map((f) => set.filter((r, i) => r.lang === lang && a[i] === f).length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${lang} folds are balanced: ${sizes}`);
  }
  // Another language's rows never move a language's folds.
  const esOnly = set.filter((r) => r.lang === 'es');
  assert.deepEqual(assignFolds(esOnly, { folds: 5, seed: 17 }), set.map((r, i) => [r, a[i]]).filter(([r]) => r.lang === 'es').map(([, f]) => f));
});

// ---- the rule applied offline ----

// A local candidate as `suggest` annotates it.
const local = (slug, gap, extra = {}) => ({
  slug, fts_rank: null, vector_rank: null, similarity: null, fts_table: 'en', table_rank: 1, bm25_gap: gap, matched_terms: 3,
  active: false, review: 'approved', passed: true, rejected_by: null, ...extra,
});
const hosted = (slug, fts, vec, sim, extra = {}) => ({
  slug, fts_rank: fts, vector_rank: vec, similarity: sim, fts_table: null, table_rank: null, bm25_gap: null, matched_terms: null,
  active: false, review: 'approved', passed: true, rejected_by: null, ...extra,
});

test('suggestedSlugs applies the rule to the kept candidates, capped at max, honouring retired and unreviewed', () => {
  const record = { candidates: [
    local('a', 2, { rejected_by: 'retired' }), local('b', 2, { review: 'unreviewed', rejected_by: 'unreviewed' }),
    local('c', 0.5), local('d', 2), local('e', 2, { table_rank: 2 }), local('f', 3),
  ] };
  assert.deepEqual(suggestedSlugs(record, 'local', { localMinGap: 1 }, 5), ['d', 'f']);
  assert.deepEqual(suggestedSlugs(record, 'local', { localMinGap: 1 }, 1), ['d']);
  assert.deepEqual(suggestedSlugs(record, 'local', { localMinGap: 0.4 }, 5), ['c', 'd', 'f']);
  const h = { candidates: [hosted('x', 1, 1, 0.6), hosted('y', 3, 1, 0.57), hosted('z', 1, 3, 0.9)] };
  assert.deepEqual(suggestedSlugs(h, 'hosted', { maxRanks: 2, minSimilarity: 0.5 }, 5), ['x', 'y']);
  assert.deepEqual(suggestedSlugs(h, 'hosted', { maxRanks: 2, minSimilarity: 0.55 }, 5), ['x']);
});

test('buildGrid: local varies localMinGap at the observed rank-1 gap percentiles, hosted varies maxRanks x minSimilarity', () => {
  const records = [{ candidates: Array.from({ length: 20 }, (_, i) => local(`s${i}`, i + 1)) }];
  const lg = buildGrid(records, 'local');
  assert.deepEqual(lg.map((p) => p.localMinGap), [10, 15, 18, 19]);
  assert.ok(lg.every((p) => p.maxRanks === 2 && p.minSimilarity === 0.45), 'the unused dimensions stay at the default');
  const hg = buildGrid(records, 'hosted');
  assert.equal(hg.length, 4 * 6);
  assert.deepEqual([...new Set(hg.map((p) => p.maxRanks))], [1, 2, 3, 4]);
  assert.deepEqual([...new Set(hg.map((p) => p.minSimilarity))], [0.35, 0.4, 0.45, 0.5, 0.55, 0.6]);
  assert.ok(hg.every((p) => p.localMinGap === DEFAULT_RULE.localMinGap));
  // No rank-1 gap observed: the default gap is the only point.
  assert.deepEqual(buildGrid([{ candidates: [] }], 'local').map((p) => p.localMinGap), [DEFAULT_RULE.localMinGap]);
});

test('buildGrid: local crosses the English-table gaps with the Spanish-table gaps, each from its own rank-1 rows', () => {
  const en = Array.from({ length: 20 }, (_, i) => local(`e${i}`, i + 1));
  const es = Array.from({ length: 20 }, (_, i) => local(`s${i}`, (i + 1) / 10, { fts_table: 'es' }));
  const gloss = [local('g', 1000, { fts_table: 'en-gloss' })];
  const grid = buildGrid([{ candidates: [...en, ...es, ...gloss] }], 'local');
  assert.deepEqual([...new Set(grid.map((p) => p.localMinGapEs))], [1, 1.5, 1.8, 1.9]);
  // en-gloss shares the English scale, so its gaps join the English dimension.
  assert.equal(new Set(grid.map((p) => p.localMinGap)).size, 4);
  assert.equal(grid.length, 16);
  // No Spanish rank-1 gap observed: that dimension is the default alone.
  assert.deepEqual([...new Set(buildGrid([{ candidates: en }], 'local').map((p) => p.localMinGapEs))], [DEFAULT_RULE.localMinGapEs]);
  assert.ok(buildGrid([{ candidates: en }], 'hosted').every((p) => p.localMinGapEs === DEFAULT_RULE.localMinGapEs));
});

test('buildGrid cuts local gaps down to 2 decimals, without float drift (1.15 stays 1.15)', () => {
  const gaps = (...g) => [{ candidates: g.map((x, i) => local(`s${i}`, x)) }];
  assert.deepEqual(buildGrid(gaps(1.119, 1.999, 2.345, 3.0049), 'local').map((p) => p.localMinGap), [1.99, 2.34, 3]);
  assert.deepEqual(buildGrid(gaps(1.15, 1.999), 'local').map((p) => p.localMinGap), [1.15, 1.99]);
});

// ---- cross-validation ----

const A = (i) => ({ row: { q: `row ${i}`, slug: 'a', lang: 'en' }, record: { latency_ms: 5, candidates: [local('a', 2)] } });
const NULLROW = { row: { q: 'row null', slug: null, lang: 'en' }, record: { latency_ms: 5, candidates: [local('z', 2)] } };
const GRID = [{ maxRanks: 2, minSimilarity: 0.45, localMinGap: 1 }, { maxRanks: 2, minSimilarity: 0.45, localMinGap: 3 }];

function fixture() {
  const items = [A(0), A(1), A(2), A(3), NULLROW];
  const byRow = new Map(items.map((x) => [x.row, x.record]));
  return { rows: items.map((x) => x.row), byRow, runRow: async (row) => byRow.get(row) };
}

test('held-out results never influence the chosen thresholds: the training best wins over the held-out best', async () => {
  const { rows: set, runRow } = fixture();
  const cv = await crossValidate(set, runRow, { folds: 5, seed: 17, grid: GRID, mode: 'local', max: 2 });
  const folds = cv.perLang.en.folds;
  assert.equal(folds.length, 5);
  const nullFold = folds.find((f) => f.heldOut.includes(4));
  // Trained on four rows that all want the low gap, so it keeps gap 1, although gap 3 is the better answer for the
  // null row it is evaluated on.
  assert.equal(nullFold.chosen.localMinGap, 1);
  assert.deepEqual(nullFold.heldOutMetrics.precision, { pct: 0, n: 0, d: 1 });
  assert.equal(cv.recommended.en.localMinGap, 1);
});

test('mutating the held-out rows of a fold changes its report but not the thresholds chosen for it', async () => {
  const base = fixture();
  const before = await crossValidate(base.rows, base.runRow, { folds: 5, seed: 17, grid: GRID, mode: 'local', max: 2 });
  const f0 = before.perLang.en.folds[0];
  const held = f0.heldOut.map((i) => base.rows[i]);
  // The held-out rows now answer differently: their metrics must move, the fold's thresholds must not.
  const runRow = async (row) => (held.includes(row)
    ? { latency_ms: 5, candidates: row.slug === null ? [] : [local('wrong', 2)] }
    : base.byRow.get(row));
  const after = await crossValidate(base.rows, runRow, { folds: 5, seed: 17, grid: GRID, mode: 'local', max: 2 });
  assert.deepEqual(after.perLang.en.folds[0].heldOut, f0.heldOut);
  assert.deepEqual(after.perLang.en.folds[0].chosen, f0.chosen);
  assert.notDeepEqual(after.perLang.en.folds[0].heldOutMetrics, f0.heldOutMetrics);
});

test('without an explicit grid each fold builds its candidates from its training rows only', async () => {
  // Ten English rows with distinct rank-1 gaps 1..10: the full-set percentiles differ from any fold's training ones.
  const set = Array.from({ length: 10 }, (_, i) => ({ q: `gap row ${i}`, slug: i % 3 === 0 ? null : 'a', lang: 'en' }));
  const records = new Map(set.map((row, i) => [row, { latency_ms: 5, candidates: [local(row.slug ?? 'z', i + 1)] }]));
  const run = (map) => crossValidate(set, async (row) => map.get(row), { folds: 5, seed: 17, mode: 'local', max: 2 });
  const before = await run(records);
  const f0 = before.perLang.en.folds[0];
  assert.ok(f0.grid.length >= 1 && f0.grid.every((p) => typeof p.localMinGap === 'number'));
  // The only gaps a fold's grid may use are its training rows' own.
  const trainGaps = set.flatMap((row, i) => (f0.heldOut.includes(i) ? [] : [i + 1]));
  assert.ok(f0.grid.every((p) => trainGaps.includes(p.localMinGap)), `${JSON.stringify(f0.grid)} from ${trainGaps}`);
  // A held-out row's gap moves far away: this fold's candidates and choice must not move.
  const held = set[f0.heldOut[0]];
  const changed = new Map(records);
  changed.set(held, { latency_ms: 5, candidates: [local(held.slug ?? 'z', 500)] });
  const after = await run(changed);
  assert.deepEqual(after.perLang.en.folds[0].grid, f0.grid);
  assert.deepEqual(after.perLang.en.folds[0].chosen, f0.chosen);
  assert.notDeepEqual(after.perLang.en.folds[0].heldOutMetrics, f0.heldOutMetrics);
});

test('every row is held out exactly once and each row is searched exactly once', async () => {
  const { rows: set, byRow } = fixture();
  const searched = [];
  const cv = await crossValidate(set, async (row) => { searched.push(row); return byRow.get(row); }, { folds: 5, seed: 17, grid: GRID, mode: 'local', max: 2 });
  assert.equal(searched.length, set.length);
  assert.deepEqual(cv.perLang.en.folds.flatMap((f) => f.heldOut).sort(), [0, 1, 2, 3, 4]);
  assert.equal(cv.perLang.en.heldOut.recall.d, 4);
  assert.equal(cv.perLang.en.train.recall.d, 16);
});

test('crossValidate is deterministic for a fixed seed', async () => {
  const { rows: set, runRow } = fixture();
  const opts = { folds: 5, seed: 17, grid: GRID, mode: 'local', max: 2 };
  assert.deepEqual(await crossValidate(set, runRow, opts), await crossValidate(set, runRow, opts));
});

// ---- the runner, with a fake search ----

const fakeSearch = (table) => (query) => table(query);
const depsFor = (searchImpl) => () => ({
  search: async (query, mode) => searchImpl(query, mode),
  activeKeys: async () => new Set(),
  sessionStore: { seen: async () => [], add: async () => {} },
});

async function config(overrides = {}) {
  const base = await loadSuggestConfig(await tempDir('sv-cal-cfg-'));
  return { ...base, suggest: { ...base.suggest, ...overrides } };
}

function evalRows() {
  // Every even row has its skill; the null rows have none. The fake search answers by the row number in the query.
  return [...rows('en', 20, 8), ...rows('es', 20, 8)].map((r, i) => ({ ...r, q: `${r.q} ${i}` }));
}
const answerKey = (rs) => new Map(rs.map((r, i) => [r.q, { ...r, i }]));

test('calibrate runs each row once with entry eval, never writes the log or the config, and reports per language', async () => {
  const rs = evalRows();
  const key = answerKey(rs);
  const calls = [];
  const cfg = await config();
  const report = await calibrate({
    rows: rs, mode: 'local', config: cfg, cwd: '/nowhere', home: '/nowhere',
    depsFor: depsFor(async (q) => {
      calls.push(q);
      const row = key.get(q);
      // Perfect for even-numbered skill rows, and a confident false positive on null rows 0-3.
      if (row.slug === null) return row.i % 4 === 0 ? { candidates: [{ slug: 'junk', name: 'junk', description: 'x', kind: 'skill', review: 'approved', table_rank: 1, bm25_gap: 10, matched_terms: 3 }], variant: 'local' } : { candidates: [], variant: 'local' };
      return { candidates: [{ slug: row.slug, name: row.slug, description: 'x', kind: 'skill', review: 'approved', table_rank: 1, bm25_gap: 10, matched_terms: 3 }], variant: 'local' };
    }),
  });
  assert.equal(calls.length, rs.length, 'one search per row');
  assert.equal(report.mode, 'local');
  assert.equal(report.rows.length, rs.length);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.current.en.recall, { pct: 100, n: 12, d: 12 });
  assert.equal(report.current.es.recall.d, 12);
  assert.ok(report.current.en.precision.d >= 12);
  assert.ok(report.cv.perLang.en.heldOut.recall.d === 12);
  // The offline rule at the configured rule reproduces what the pipeline itself suggested.
  for (const r of report.rows) assert.deepEqual(r.suggested, suggestedSlugs(r.record, 'local', cfg.suggest.rule, cfg.suggest.maxSuggestions));
});

test('calibrate keeps a skipped:short row as no suggestion, so it still counts toward recall (spec 3.1)', async () => {
  const rs = [...evalRows(), { q: 'too short', slug: 'a', lang: 'en' }];
  const key = answerKey(rs);
  const report = await calibrate({
    rows: rs, mode: 'local', config: await config(), cwd: '/nowhere', home: '/nowhere',
    depsFor: depsFor(async (q) => ({ candidates: [{ slug: key.get(q).slug ?? 'none', name: 'n', description: 'd', kind: 'skill', review: 'approved', table_rank: 1, bm25_gap: 10, matched_terms: 3 }], variant: 'local' })),
  });
  assert.equal(report.skipped, 0);
  assert.equal(report.rows.length, rs.length);
  const short = report.rows.find((r) => r.outcome === 'skipped:short');
  assert.deepEqual([short.slug, short.suggested], ['a', []]);
  // 12 skill rows answered correctly plus the short one that expected a skill and got none.
  assert.deepEqual(report.current.en.recall, { pct: 92, n: 12, d: 13 });
});

test('calibrate counts a row an adapter skipped and leaves it out of the metrics', async () => {
  const rs = [...evalRows(), { q: 'a spare english prompt about something 99', slug: 'skill-99', lang: 'en' }];
  const key = answerKey(rs);
  const dropped = rs.find((r) => r.lang === 'en' && r.slug !== null);
  const report = await calibrate({
    rows: rs, mode: 'local', config: await config(), cwd: '/nowhere', home: '/nowhere',
    depsFor: depsFor(async (q) => (q === dropped.q
      ? { outcome: 'skipped:busy' }
      : { candidates: [{ slug: key.get(q).slug ?? 'none', name: 'n', description: 'd', kind: 'skill', review: 'approved', table_rank: 1, bm25_gap: 10, matched_terms: 3 }], variant: 'local' })),
  });
  assert.equal(report.skipped, 1);
  assert.equal(report.rows.length, rs.length - 1);
  assert.equal(report.current.en.recall.d, 12);
});

test('calibrate in hosted mode gives each row its own session id and reports the variant per row', async () => {
  const rs = evalRows();
  const sessions = [];
  const report = await calibrate({
    rows: rs, mode: 'hosted', config: await config({ hosted: true }), cwd: '/nowhere', home: '/nowhere',
    depsFor: (sessionId) => { sessions.push(sessionId); return depsFor(async (q, mode) => ({
      candidates: [{ slug: 'skill-x', name: 'n', description: 'd', kind: 'skill', review: 'approved', fts_rank: 1, vector_rank: 1, similarity: 0.7 }],
      variant: mode === 'hosted' && q.startsWith('es') ? 'rrf-bilingual' : 'rrf-english',
    }))(); },
  });
  assert.equal(new Set(sessions).size, rs.length);
  assert.ok(sessions.every((s) => /^[A-Za-z0-9-]{1,64}$/.test(s)));
  assert.deepEqual([...new Set(report.rows.filter((r) => r.lang === 'es').map((r) => r.variant))], ['rrf-bilingual']);
  const text = formatCalibration(report);
  assert.match(text, /variant=rrf-bilingual/);
  assert.match(text, /variant=rrf-english/);
});

test('every printed percentage carries its raw counts, and the recommendation is labelled guidance', async () => {
  const rs = evalRows();
  const key = answerKey(rs);
  const report = await calibrate({
    rows: rs, mode: 'local', config: await config(), cwd: '/nowhere', home: '/nowhere',
    depsFor: depsFor(async (q) => {
      const row = key.get(q);
      const slug = row.slug ?? (row.i % 3 === 0 ? 'junk' : null);
      return { candidates: slug ? [{ slug, name: slug, description: 'x', kind: 'skill', review: 'approved', table_rank: 1, bm25_gap: 1 + (row.i % 5), matched_terms: 3 }] : [], variant: 'local' };
    }),
  });
  const text = formatCalibration(report);
  const bare = text.match(/\d+%/g) ?? [];
  const paired = text.match(/\d+% \(\d+\/\d+\)/g) ?? [];
  assert.ok(bare.length > 0);
  assert.equal(bare.length, paired.length, text);
  assert.match(text, /guidance \(folds of ~4 prompts are noisy\)/);
  // The recommendation is a final fit on all rows; the label must not claim it was chosen on training folds only.
  assert.match(text, /recommended thresholds, fit on all rows of each language/);
  assert.doesNotMatch(text, /chosen on training folds only/);
  assert.match(text, /localMinGap /);
  assert.match(text, /localMinGapEs /);
  assert.match(text, /p50/);
  assert.match(text, /p95/);
  assert.doesNotMatch(text, /prompt number/, 'the report never prints the prompt text');
  assert.doesNotMatch(text, /NaN|undefined/);
  assert.match(text, /n\/a \(0\/0\)|\d+% \(\d+\/\d+\)/);
});

test('calibrate in hosted mode reproduces the pipeline\'s own suggestions with the offline rule', async () => {
  const rs = evalRows();
  const cfg = await config({ hosted: true });
  const sims = [0.9, 0.5, 0.3];
  const report = await calibrate({
    rows: rs, mode: 'hosted', config: cfg, cwd: '/nowhere', home: '/nowhere',
    depsFor: depsFor(async (q) => ({
      candidates: [1, 2, 3].map((rank) => ({
        slug: `s${rank}`, name: 'n', description: 'd', kind: 'skill', review: 'approved', fts_rank: rank, vector_rank: rank === 3 ? 1 : rank, similarity: sims[rank - 1] - (q.length % 3) * 0.01,
      })),
      variant: 'rrf-english',
    })),
  });
  assert.ok(report.rows.some((r) => r.suggested.length > 0) && report.rows.some((r) => r.record.candidates.some((c) => !c.passed)));
  for (const r of report.rows) assert.deepEqual(r.suggested, suggestedSlugs(r.record, 'hosted', cfg.suggest.rule, cfg.suggest.maxSuggestions));
});

test('the training line says it is pooled over the folds', async () => {
  const rs = evalRows();
  const key = answerKey(rs);
  const report = await calibrate({
    rows: rs, mode: 'local', config: await config(), cwd: '/nowhere', home: '/nowhere',
    depsFor: depsFor(async (q) => ({ candidates: key.get(q).slug ? [{ slug: key.get(q).slug, name: 'n', description: 'd', kind: 'skill', review: 'approved', table_rank: 1, bm25_gap: 10, matched_terms: 3 }] : [], variant: 'local' })),
  });
  const text = formatCalibration(report);
  assert.match(text, /training \(pooled over 5 folds\)/);
  assert.match(text, /held-out \(5 folds\)/);
});

test('calibrate re-checks the minimums once skipped rows are dropped, naming the skip count', async () => {
  // 20 rows per language are enough on paper; the search skips one Spanish row (a busy vault), which leaves 19.
  const rs = evalRows();
  const dropped = rs.find((r) => r.lang === 'es' && r.slug !== null);
  const key = answerKey(rs);
  await assert.rejects(
    calibrate({
      rows: rs, mode: 'local', config: await config(), cwd: '/nowhere', home: '/nowhere',
      depsFor: depsFor(async (q) => (q === dropped.q
        ? { outcome: 'skipped:busy' }
        : { candidates: [{ slug: key.get(q).slug ?? 'x', name: 'n', description: 'd', kind: 'skill', review: 'approved', table_rank: 1, bm25_gap: 10, matched_terms: 3 }], variant: 'local' })),
    }),
    (e) => /1 row skipped/.test(e.message) && /es: need 1 more row/.test(e.message) && !/en: need/.test(e.message),
  );
});

test('calibrate surfaces a search failure instead of scoring it', async () => {
  await assert.rejects(
    calibrate({ rows: evalRows(), mode: 'local', config: await config(), cwd: '/nowhere', home: '/nowhere', depsFor: depsFor(async () => { throw new Error('vault exploded'); }) }),
    /vault exploded/,
  );
});

test('calibrate refuses when every row was skipped by the adapter', async () => {
  await assert.rejects(
    calibrate({ rows: evalRows(), mode: 'local', config: await config(), cwd: '/nowhere', home: '/nowhere', depsFor: depsFor(async () => ({ outcome: 'skipped:no-vault' })) }),
    /skipped:no-vault/,
  );
});

// ---- the command ----

test('suggestDeps hands a hosted search the purpose it is given, suggest by default and eval for calibration', async () => {
  const seen = [];
  const adapters = { hostedSearch: async (a) => { seen.push(a.purpose); return []; } };
  const ctx = { env: {}, dir: '/nowhere', home: '/nowhere', cwd: '/nowhere' };
  await suggestDeps({ ctx, config: {}, adapters }).search('q', 'hosted');
  await suggestDeps({ ctx, config: {}, purpose: 'eval', adapters }).search('q', 'hosted');
  assert.deepEqual(seen, ['suggest', 'eval']);
});

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
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

async function sandbox() {
  const home = await tempDir('sv-cal-home-');
  const state = await tempDir('sv-cal-state-');
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir: state, DatabaseSync });
  const repo = createSqliteRepo(db);
  await repo.publish(skill('zq-helper', 'Run recurring jobs periodically with cron', 'Sets up a crontab for recurring jobs.'));
  await repo.publish(skill('gardening', 'Grow tomatoes', 'Water daily.'));
  db.close();
  return { home, state, env: { HOME: home, HEADJACK_HOME: state } };
}

async function writeEval(state, set) {
  await fsp.mkdir(path.join(state, 'suggest'), { recursive: true });
  await fsp.writeFile(path.join(state, 'suggest', 'eval.json'), JSON.stringify(set));
}

const cronRows = (lang, total, nulls) => Array.from({ length: total }, (_, i) => (i < nulls
  ? { q: `which bird sings loudest at dawn in the garden ${lang} ${i}`, slug: null, lang }
  : { q: `please run my recurring jobs periodically using cron on server ${lang} ${i}`, slug: 'zq-helper', lang }));

localTest('suggest --calibrate prints per-language counts and guidance, and never writes config.json', async () => {
  const box = await sandbox();
  await writeEval(box.state, [...cronRows('en', 20, 8), ...cronRows('es', 20, 8)]);
  const { code, stdout, stderr } = await runCli(['suggest', '--calibrate'], box.env);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /en:/);
  assert.match(stdout, /es:/);
  assert.match(stdout, /guidance \(folds of ~4 prompts are noisy\)/);
  assert.equal((stdout.match(/\d+%/g) ?? []).length, (stdout.match(/\d+% \(\d+\/\d+\)/g) ?? []).length, stdout);
  assert.ok(!existsSync(path.join(box.state, 'config.json')), 'the runner never writes the config');
  assert.ok(!existsSync(path.join(box.state, 'suggest', 'log.jsonl')), 'eval runs never write the log');
  assert.doesNotMatch(stdout, /recurring jobs/);
});

localTest('suggest --calibrate leaves an existing config.json byte for byte, and --json prints the report', async () => {
  const box = await sandbox();
  await writeEval(box.state, [...cronRows('en', 20, 8), ...cronRows('es', 20, 8)]);
  const cfg = JSON.stringify({ suggest: { enabled: true } }, null, 2);
  await fsp.writeFile(path.join(box.state, 'config.json'), cfg);
  const { code, stdout, stderr } = await runCli(['suggest', '--calibrate', '--json'], box.env);
  assert.equal(code, 0, stderr);
  assert.equal(await fsp.readFile(path.join(box.state, 'config.json'), 'utf8'), cfg);
  const out = JSON.parse(stdout);
  assert.equal(out.mode, 'local');
  assert.ok(out.current.en.precision && out.cv.recommended.en);
  assert.ok(!JSON.stringify(out).includes('recurring jobs'), 'the JSON carries no prompt text');
});

localTest('suggest --calibrate migrates a vault left at an older schema instead of skipping every row', async () => {
  const home = await tempDir('sv-cal-home-');
  const state = await tempDir('sv-cal-state-');
  const { DatabaseSync } = await runtimeCheck();
  // A vault file no migration has run on (user_version 0), as right after a plugin update that adds migrations.
  const old = new DatabaseSync(path.join(state, 'vault.db'));
  old.exec('create table t (x integer); drop table t');
  old.close();
  await writeEval(state, [...cronRows('en', 20, 8), ...cronRows('es', 20, 8)]);
  const { code, stdout, stderr } = await runCli(['suggest', '--calibrate', '--json'], { HOME: home, HEADJACK_HOME: state });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).skipped, 0);
  const db = new DatabaseSync(path.join(state, 'vault.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  } finally {
    db.close();
  }
});

localTest('suggest --calibrate refuses below the minimums, naming what is missing', async () => {
  const box = await sandbox();
  await writeEval(box.state, [...cronRows('en', 20, 8), ...cronRows('es', 19, 8)]);
  const { code, stderr } = await runCli(['suggest', '--calibrate'], box.env);
  assert.notEqual(code, 0);
  assert.match(stderr, /es: need 1 more row/);
});

test('suggest --save rejects --mode and --calibrate with exit 2 and writes no file', async () => {
  const box = { HOME: await tempDir('sv-cal-h-'), HEADJACK_HOME: await tempDir('sv-cal-s-') };
  for (const extra of [['--mode', 'local'], ['--calibrate']]) {
    const { code, stderr } = await runCli(['suggest', '--save', '--expect', 'none', ...extra], box);
    assert.equal(code, 2, extra.join(' '));
    assert.match(stderr, /--save takes no other suggest option/);
  }
  assert.ok(!existsSync(path.join(box.HEADJACK_HOME, 'suggest')));
});

test('suggest --calibrate rejects text, other suggest options and --mode without --calibrate', async () => {
  const box = { HOME: await tempDir('sv-cal-h-'), HEADJACK_HOME: await tempDir('sv-cal-s-') };
  for (const args of [
    ['suggest', '--calibrate', 'some text'], ['suggest', '--calibrate', '--report'], ['suggest', '--calibrate', '--enable'],
    ['suggest', '--mode', 'local'], ['suggest', '--calibrate', '--mode', 'both'], ['suggest', '--calibrate', '--session-id', 'abc'],
  ]) {
    const { code, stderr } = await runCli(args, box);
    assert.notEqual(code, 0, args.join(' '));
    assert.match(stderr, /--calibrate|--mode/, args.join(' '));
  }
});
