// The decision rule of the suggestion pipeline (spec §3.5): pure, no I/O, no npm dependencies.
// `passes(candidate, mode, rule)` says whether a search candidate is confident enough to be suggested, and why not.

// The local gaps come from labelled prompts (docs/suggest-calibration.md): 159 English and Spanish prompts against a
// 152-skill vault, every (localMinGap, localMinGapEs) pair scored at one suggestion per prompt. 5.5 and 2.5 sit in the
// middle of the plateau where precision is highest before recall drops; on a blind set of 70 prompts they gave 87% of
// suggestions right (39% before) and 68% recall. localMinGapEs applies to a candidate won in the Spanish example-request
// table, whose bm25 runs on a smaller scale (one short column, no stemming); localMinGap to every other table. The
// synthetic-vault derivation (node scripts/derive-local-gap.mjs: at most one random two-word query in ten passing) stays
// as a floor, checked by the tests.
export const DEFAULT_RULE = Object.freeze({ maxRanks: 2, minSimilarity: 0.45, localMinGap: 5.5, localMinGapEs: 2.5 });

// A rule value that is null or absent means the built-in default, never "no constraint".
export function resolveRule(rule) {
  const given = rule ?? {};
  return {
    maxRanks: given.maxRanks ?? DEFAULT_RULE.maxRanks,
    minSimilarity: given.minSimilarity ?? DEFAULT_RULE.minSimilarity,
    localMinGap: given.localMinGap ?? DEFAULT_RULE.localMinGap,
    localMinGapEs: given.localMinGapEs ?? DEFAULT_RULE.localMinGapEs,
  };
}

const VECTOR_ONLY_MARGIN = 0.05;
const ok = { pass: true, reason: 'ok' };
const fail = (reason) => ({ pass: false, reason });

// A comparison with null or undefined is false.
const atMost = (value, limit) => typeof value === 'number' && value <= limit;
const atLeast = (value, limit) => typeof value === 'number' && value >= limit;

function passesHosted(c, { maxRanks, minSimilarity }) {
  if (atMost(c.fts_rank, maxRanks) && atMost(c.vector_rank, maxRanks)) {
    return atLeast(c.similarity, minSimilarity) ? ok : fail('similarity');
  }
  if (c.vector_rank === 1) {
    // toFixed keeps 0.45 + 0.05 from drifting off 0.5.
    const vectorOnly = Number((minSimilarity + VECTOR_ONLY_MARGIN).toFixed(10));
    return atLeast(c.similarity, vectorOnly) ? ok : fail('similarity');
  }
  return fail('ranks');
}

function passesLocal(c, { localMinGap, localMinGapEs }) {
  if (c.table_rank !== 1) return fail('not-top');
  const minGap = c.fts_table === 'es' ? localMinGapEs : localMinGap;
  if (typeof c.bm25_gap === 'number') return c.bm25_gap >= minGap ? ok : fail('gap');
  return atLeast(c.matched_terms, 2) ? ok : fail('terms');
}

export function passes(candidate, mode, rule) {
  const resolved = resolveRule(rule);
  if (mode === 'hosted') return passesHosted(candidate, resolved);
  if (mode === 'local') return passesLocal(candidate, resolved);
  throw new Error(`unknown suggestion mode: ${mode}`);
}
