#!/usr/bin/env node
// Derives DEFAULT_RULE.localMinGap (lib/suggest-rule.mjs): builds the synthetic 400-skill vault in a temp dir, runs 1,000
// random two-distinct-word queries, prints the 90th percentile of the rank-1 bm25 gap rounded up to 2 decimals and the
// fraction of those queries that pass the local rule at that value. Exits 1 when that fraction is above 10%, the spec's
// "at most one in ten" (§3.5). Usage: node scripts/derive-local-gap.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeCheck } from '../lib/local/runtime.mjs';
import { openVaultReadOnly } from '../lib/local/schema.mjs';
import { createSqliteRepo } from '../lib/local/sqlite-repo.mjs';
import { passes } from '../lib/suggest-rule.mjs';
import { buildSyntheticVault, syntheticQueries } from '../test/synthetic-vault.mjs';

export const QUERIES = 1000;
export const MAX_PASS_FRACTION = 0.1;
const PERCENTILE = 0.9;
const GAP_DECIMALS = 100;

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

// The rank-1 row of each query's results (undefined when the query finds nothing).
export async function rankOneRows(repo, queries) {
  const rows = [];
  for (const q of queries) rows.push((await repo.searchSignals(q, { limit: 5 })).find((r) => r.table_rank === 1));
  return rows;
}

export function passFraction(rows, localMinGap) {
  return rows.filter((r) => r && passes(r, 'local', { localMinGap }).pass).length / rows.length;
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'derive-local-gap-'));
  try {
    const started = Date.now();
    await buildSyntheticVault(dir);
    console.error(`built the 400-skill vault in ${Date.now() - started} ms`);
    const { DatabaseSync } = await runtimeCheck();
    const opened = openVaultReadOnly({ dir, DatabaseSync });
    if (!opened.ok) throw new Error(`cannot open the synthetic vault: ${opened.reason}`);
    try {
      const rows = await rankOneRows(createSqliteRepo(opened.db), syntheticQueries({ count: QUERIES }));
      const gaps = rows.filter((r) => r && typeof r.bm25_gap === 'number').map((r) => r.bm25_gap).sort((a, b) => a - b);
      if (!gaps.length) throw new Error('no query produced a rank-1 gap');
      const p90 = percentile(gaps, PERCENTILE);
      const localMinGap = Math.ceil(p90 * GAP_DECIMALS) / GAP_DECIMALS;
      const fraction = passFraction(rows, localMinGap);
      console.log(`queries=${QUERIES} with-gap=${gaps.length} p90=${p90} localMinGap=${localMinGap} pass-fraction=${fraction}`);
      if (fraction > MAX_PASS_FRACTION) {
        console.error(`pass fraction ${fraction} is above ${MAX_PASS_FRACTION}`);
        process.exitCode = 1;
      }
    } finally {
      opened.db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
