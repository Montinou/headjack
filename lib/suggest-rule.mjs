// The decision rule of the suggestion pipeline (spec §3.5): pure, no I/O, no npm dependencies.
// `passes(candidate, mode, rule)` says whether a search candidate is confident enough to be suggested, and why not.

// localMinGap is derived, not guessed: the 90th percentile of the rank-1 bm25 gap over 1,000 random two-distinct-word
// queries on the synthetic 400-skill vault (test/synthetic-vault.mjs: seeded Zipf text, so common and rare words both
// appear), rounded up to 2 decimals, so that at most one in ten random queries puts a candidate through.
//   command: node scripts/derive-local-gap.mjs
//   output:  queries=1000 with-gap=1000 p90=1.1057238462717622 localMinGap=1.11 pass-fraction=0.099
// The script exits 1 when the pass fraction is above 0.10. S8 revises this value against real prompts.
export const DEFAULT_RULE = Object.freeze({ maxRanks: 2, minSimilarity: 0.45, localMinGap: 1.11 });

// A rule value that is null or absent means the built-in default, never "no constraint".
export function resolveRule(rule) {
  const given = rule ?? {};
  return {
    maxRanks: given.maxRanks ?? DEFAULT_RULE.maxRanks,
    minSimilarity: given.minSimilarity ?? DEFAULT_RULE.minSimilarity,
    localMinGap: given.localMinGap ?? DEFAULT_RULE.localMinGap,
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

function passesLocal(c, { localMinGap }) {
  if (c.table_rank !== 1) return fail('not-top');
  if (typeof c.bm25_gap === 'number') return c.bm25_gap >= localMinGap ? ok : fail('gap');
  return atLeast(c.matched_terms, 2) ? ok : fail('terms');
}

export function passes(candidate, mode, rule) {
  const resolved = resolveRule(rule);
  if (mode === 'hosted') return passesHosted(candidate, resolved);
  if (mode === 'local') return passesLocal(candidate, resolved);
  throw new Error(`unknown suggestion mode: ${mode}`);
}
