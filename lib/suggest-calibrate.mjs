// The calibration runner behind `headjack suggest --calibrate` (spec §10): it measures the suggestion pipeline against an
// eval set and prints thresholds as guidance. It never writes the config. Every row is searched once (entry 'eval': no
// active state, no log, no session dedupe) and the candidates it returned are kept; every grid point is then applied
// offline with the decision rule, so a grid costs no further search. No npm dependencies.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './errors.mjs';
import { SLUG_RE } from './handlers.mjs';
import { suggest } from './suggest.mjs';
import { DEFAULT_RULE, passes, resolveRule } from './suggest-rule.mjs';

const LANGS = ['en', 'es'];
const MIN_ROWS = 20;
const MIN_NULL_ROWS = 8;
const DEFAULT_FOLDS = 5;
const DEFAULT_SEED = 17;
const GAP_PERCENTILES = [50, 75, 90, 95];
const MAX_RANKS_GRID = [1, 2, 3, 4];
const MIN_SIMILARITY_GRID = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const GUIDANCE = 'guidance (folds of ~4 prompts are noisy)';

export const evalFile = (dir) => path.join(dir, 'suggest', 'eval.json');

// ---- the eval set ----

// <dir>/suggest/eval.json: an array of { q, slug|null, lang }. Throws a UserError naming the file or the first bad row.
export async function loadEvalSet(dir) {
  const file = evalFile(dir);
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') throw new UserError(`no eval set at ${file}: a JSON array of { "q", "slug" | null, "lang": "en" | "es" } rows`);
    throw new UserError(`${file}: not valid JSON`);
  }
  if (!Array.isArray(data)) throw new UserError(`${file}: must be an array of { q, slug, lang } rows`);
  return data.map((row, i) => {
    const bad = (why) => new UserError(`${file}: row ${i + 1}: ${why}`);
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw bad('must be an object');
    if (typeof row.q !== 'string' || !row.q.trim()) throw bad('q must be a non-empty string');
    if (row.slug !== null && !(typeof row.slug === 'string' && SLUG_RE.test(row.slug))) throw bad('slug must be a slug or null');
    if (!LANGS.includes(row.lang)) throw bad('lang must be en or es');
    return { q: row.q, slug: row.slug, lang: row.lang };
  });
}

// What the eval set lacks before a run is worth reading: ≥ 20 rows per language, ≥ 8 of them `slug: null`.
export function checkMinimums(rows) {
  const missing = [];
  const plural = (n, noun) => `${n} more ${noun}${n === 1 ? '' : 's'}`;
  for (const lang of LANGS) {
    const mine = rows.filter((r) => r.lang === lang);
    const nulls = mine.filter((r) => r.slug === null).length;
    if (mine.length < MIN_ROWS) missing.push(`${lang}: need ${plural(MIN_ROWS - mine.length, 'row')}`);
    if (nulls < MIN_NULL_ROWS) missing.push(`${lang}: need ${plural(MIN_NULL_ROWS - nulls, 'slug: null row')}`);
  }
  return missing;
}

// ---- the rule, offline ----

// The slugs the pipeline would suggest from a kept search `record` under `rule`: the same order of filters as
// lib/suggest.mjs, with `retired` and `unreviewed` read from the annotation the pipeline made (eval has no active state
// and no seen set), then the decision rule, then the cap.
export function suggestedSlugs(record, mode, rule, max) {
  const out = [];
  for (const c of record.candidates) {
    if (c.rejected_by === 'active' || c.rejected_by === 'retired' || c.rejected_by === 'unreviewed') continue;
    if (!passes(c, mode, rule).pass) continue;
    if (out.length >= max) break;
    out.push(c.slug);
  }
  return out;
}

// ---- metrics ----

const share = (n, d) => ({ pct: d ? Math.round((n / d) * 100) : null, n, d });

// Nearest-rank percentile of a list of numbers; null for none.
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// One language's results: { lang, slug (expected, or null), suggested: slug[], latency_ms }. Precision is per suggested
// skill and correct only when it equals the expected slug, so any suggestion on a null row is a false positive; recall
// is per row that expects a skill, hit when the skill is among the suggestions.
function summarize(results) {
  let suggestedCount = 0;
  let correct = 0;
  let expecting = 0;
  let hit = 0;
  for (const r of results) {
    suggestedCount += r.suggested.length;
    if (r.slug === null) continue;
    expecting++;
    correct += r.suggested.filter((s) => s === r.slug).length;
    if (r.suggested.includes(r.slug)) hit++;
  }
  const latencies = results.map((r) => r.latency_ms);
  return { precision: share(correct, suggestedCount), recall: share(hit, expecting), p50: percentile(latencies, 50), p95: percentile(latencies, 95) };
}

export function metrics(results) {
  const out = {};
  for (const lang of [...new Set(results.map((r) => r.lang))]) out[lang] = summarize(results.filter((r) => r.lang === lang));
  return out;
}

// ---- folds ----

// A small deterministic PRNG, so a fixed seed always gives the same folds.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The fold of every row, in input order. Each language is shuffled on its own (a fresh generator per language, so another
// language's rows never move its folds) and dealt round-robin: folds differ in size by at most one row.
export function assignFolds(rows, { folds = DEFAULT_FOLDS, seed = DEFAULT_SEED } = {}) {
  const out = new Array(rows.length);
  for (const lang of [...new Set(rows.map((r) => r.lang))]) {
    const idx = rows.flatMap((r, i) => (r.lang === lang ? [i] : []));
    const random = mulberry32(seed);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    idx.forEach((rowIndex, k) => { out[rowIndex] = k % folds; });
  }
  return out;
}

// ---- the grid ----

// The points to try. Only the dimensions the mode reads vary (hosted: maxRanks x minSimilarity; local: localMinGap x
// localMinGapEs, each at the 50/75/90/95th percentile of the rank-1 gaps observed in its own tables (the Spanish table for
// localMinGapEs, the others for localMinGap), cut down to 2 decimals so the candidate at a percentile still passes it);
// the others stay at the default, so a point never differs from another by a value nothing reads.
export function buildGrid(records, mode) {
  const { localMinGap, localMinGapEs } = DEFAULT_RULE;
  if (mode === 'hosted') {
    return MAX_RANKS_GRID.flatMap((maxRanks) => MIN_SIMILARITY_GRID.map((minSimilarity) => ({ maxRanks, minSimilarity, localMinGap, localMinGapEs })));
  }
  const rankOne = records.flatMap((r) => r.candidates).filter((c) => c.table_rank === 1 && typeof c.bm25_gap === 'number');
  const values = (gaps, fallback) => (gaps.length
    ? [...new Set(GAP_PERCENTILES.map((p) => Math.floor(percentile(gaps, p) * 100 + 1e-9) / 100))]
    : [fallback]);
  const en = values(rankOne.filter((c) => c.fts_table !== 'es').map((c) => c.bm25_gap), localMinGap);
  const es = values(rankOne.filter((c) => c.fts_table === 'es').map((c) => c.bm25_gap), localMinGapEs);
  return en.flatMap((gap) => es.map((gapEs) => ({
    maxRanks: DEFAULT_RULE.maxRanks, minSimilarity: DEFAULT_RULE.minSimilarity, localMinGap: gap, localMinGapEs: gapEs,
  })));
}

// ---- cross-validation ----

// F1 of a set of results, then fewer wrong suggestions; the first grid point wins a full tie.
function score(results) {
  const { precision, recall } = summarize(results);
  const p = precision.d ? precision.n / precision.d : 0;
  const r = recall.d ? recall.n / recall.d : 0;
  return { f1: p + r ? (2 * p * r) / (p + r) : 0, wrong: precision.d - precision.n };
}

const better = (a, b) => a.f1 > b.f1 || (a.f1 === b.f1 && a.wrong < b.wrong);

// 5-fold cross-validation per language. `runRow(row)` resolves to the kept search record { candidates, latency_ms } and
// is called once per row, in order. For each fold both the candidate grid (unless the caller passes `grid`) and the point
// chosen from it come from the training rows only; the held-out rows only report. Result: { perLang: { <lang>: { rows,
// train, heldOut, folds: [{ fold, heldOut: [row index], grid, chosen, trainMetrics, heldOutMetrics }] } }, recommended:
// { <lang>: rule } }, where train and heldOut pool the folds' results. The recommendation is the final fit, as in any
// cross-validation: the best point on all of the language's rows over a grid built from all of them (the held-out numbers
// above are the estimate of how it generalizes).
export async function crossValidate(rows, runRow, { folds = DEFAULT_FOLDS, seed = DEFAULT_SEED, grid, mode = 'local', max = 2 } = {}) {
  const records = [];
  for (const row of rows) records.push(await runRow(row));
  const assigned = assignFolds(rows, { folds, seed });
  const resultsFor = (indices, rule) => indices.map((i) => ({
    lang: rows[i].lang, slug: rows[i].slug, suggested: suggestedSlugs(records[i], mode, rule, max), latency_ms: records[i].latency_ms,
  }));

  const perLang = {};
  const recommended = {};
  // The first grid point with the best score wins; ties keep grid order.
  const choose = (indices, points) => {
    let best = 0;
    let bestScore = score(resultsFor(indices, points[0]));
    for (let g = 1; g < points.length; g++) {
      const s = score(resultsFor(indices, points[g]));
      if (better(s, bestScore)) { best = g; bestScore = s; }
    }
    return points[best];
  };
  for (const lang of [...new Set(rows.map((r) => r.lang))]) {
    const mine = rows.flatMap((r, i) => (r.lang === lang ? [i] : []));
    const pooledTrain = [];
    const pooledHeld = [];
    const perFold = [];
    for (let fold = 0; fold < folds; fold++) {
      const heldOut = mine.filter((i) => assigned[i] === fold);
      if (!heldOut.length) continue;
      const train = mine.filter((i) => assigned[i] !== fold);
      const points = grid ?? buildGrid(train.map((i) => records[i]), mode);
      const chosen = choose(train, points);
      const trainResults = resultsFor(train, chosen);
      const heldResults = resultsFor(heldOut, chosen);
      pooledTrain.push(...trainResults);
      pooledHeld.push(...heldResults);
      perFold.push({ fold, heldOut, grid: points, chosen, trainMetrics: summarize(trainResults), heldOutMetrics: summarize(heldResults) });
    }
    recommended[lang] = choose(mine, grid ?? buildGrid(mine.map((i) => records[i]), mode));
    perLang[lang] = { rows: mine.length, train: summarize(pooledTrain), heldOut: summarize(pooledHeld), folds: perFold };
  }
  return { perLang, recommended };
}

// ---- the run ----

// Searches every row once with entry 'eval'. `depsFor(sessionId)` builds the pipeline's deps; hosted rows get a session id
// of their own, stable across runs, so each row buckets to the same arm every time and the variant is reported per row.
// A search failure propagates. Result per row: { index, lang, slug, outcome, variant, latency_ms, suggested, record }.
export async function searchRows(rows, { mode, config, cwd, home, depsFor }) {
  const forMode = { ...config, suggest: { ...config.suggest, hosted: mode === 'hosted' } };
  const out = [];
  for (const [index, row] of rows.entries()) {
    const sessionId = mode === 'hosted' ? `calibrate-${index + 1}` : undefined;
    const run = await suggest({ text: row.q, entry: 'eval', sessionId, cwd, home, config: forMode, deps: depsFor(sessionId) });
    out.push({
      index, lang: row.lang, slug: row.slug, outcome: run.outcome, variant: run.variant, latency_ms: run.latency_ms,
      suggested: run.suggestions.map((s) => s.slug), record: { candidates: run.candidates, latency_ms: run.latency_ms },
    });
  }
  return out;
}

// The whole calibration. A row under 25 characters (skipped:short) counts as no suggestion (spec §3.1): it stays in the
// metrics with nothing suggested, so it still weighs on recall. Rows an adapter skipped (no vault, old schema, busy
// vault, no URL) were never searched: they are counted and left out of every metric; when nothing is left it throws.
export async function calibrate({ rows, mode, config, cwd, home, depsFor, folds = DEFAULT_FOLDS, seed = DEFAULT_SEED }) {
  const searched = await searchRows(rows, { mode, config, cwd, home, depsFor });
  const kept = searched.filter((r) => r.outcome === 'skipped:short' || !r.outcome.startsWith('skipped:'));
  if (!kept.length) throw new UserError(`every row was skipped (${searched[0]?.outcome ?? 'no rows'}): nothing to calibrate`);
  // Skipped rows leave the eval set: it must still hold the minimums without them.
  const short = checkMinimums(kept.map((r) => rows[r.index]));
  if (short.length) {
    const n = searched.length - kept.length;
    throw new UserError(`${n} ${n === 1 ? 'row' : 'rows'} skipped by the search, which leaves the eval set too small to calibrate:\n  ${short.join('\n  ')}`);
  }
  const rule = resolveRule(config.suggest.rule);
  const max = config.suggest.maxSuggestions;
  const keptRows = kept.map((r) => rows[r.index]);
  const byRow = new Map(keptRows.map((row, i) => [row, kept[i].record]));
  const cv = await crossValidate(keptRows, async (row) => byRow.get(row), { folds, seed, mode, max });
  return { mode, rule, max, folds, seed, skipped: searched.length - kept.length, rows: kept, current: metrics(kept), cv };
}

// ---- output ----

const fmt = ({ pct, n, d }) => (pct === null ? 'n/a (0/0)' : `${pct}% (${n}/${d})`);
const ms = (v) => (v === null ? 'n/a' : `${v} ms`);
const line = (m) => `precision ${fmt(m.precision)} · recall ${fmt(m.recall)} · p50 ${ms(m.p50)} · p95 ${ms(m.p95)}`;
const ruleText = (rule, mode) => (mode === 'hosted'
  ? `maxRanks ${rule.maxRanks}, minSimilarity ${rule.minSimilarity}`
  : `localMinGap ${rule.localMinGap}, localMinGapEs ${rule.localMinGapEs}`);

// Every percentage is followed by its raw counts; no prompt text is printed.
export function formatCalibration(report) {
  const { mode, rule, max, cv } = report;
  const out = [
    `calibration (${mode} mode): ${report.rows.length} rows searched once each${report.skipped ? `, ${report.skipped} skipped` : ''}`,
    `rule in use: ${ruleText(rule, mode)}, up to ${max} suggestions`,
  ];
  for (const lang of Object.keys(report.current)) {
    const folded = cv.perLang[lang];
    const n = folded.folds.length;
    const labels = ['rule in use', `training (pooled over ${n} folds)`, `held-out (${n} folds)`];
    const width = Math.max(...labels.map((l) => l.length));
    const lines = [line(report.current[lang]), line(folded.train), line(folded.heldOut)];
    out.push('', `${lang}: ${folded.rows} rows`, ...labels.map((l, i) => `  ${l.padEnd(width)}  ${lines[i]}`));
  }
  if (mode === 'hosted') {
    out.push('', 'rows (variant is the arm the row\'s session bucketed to):');
    for (const r of report.rows) out.push(`  #${r.index + 1} ${r.lang} expected=${r.slug ?? 'none'} suggested=${r.suggested.join(',') || 'none'} variant=${r.variant ?? '-'}`);
  }
  out.push('', `recommended thresholds, fit on all rows of each language (the held-out lines above estimate how they generalize) — ${GUIDANCE}:`);
  for (const lang of Object.keys(cv.recommended)) out.push(`  ${lang}: ${ruleText(cv.recommended[lang], mode)}`);
  out.push('', 'This runner never writes config.json: set suggest.rule yourself if you adopt a value.');
  return out.join('\n');
}
