import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVaultReadOnly } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { DEFAULT_RULE, passes, resolveRule } from '../../lib/suggest-rule.mjs';
import { buildSyntheticVault, syntheticQueries } from '../synthetic-vault.mjs';
import { MAX_PASS_FRACTION, passFraction, QUERIES, rankOneRows } from '../../scripts/derive-local-gap.mjs';

const hosted = (fts_rank, vector_rank, similarity) => ({ fts_rank, vector_rank, similarity });
const local = (table_rank, bm25_gap, matched_terms = null) => ({ table_rank, bm25_gap, matched_terms });

test('DEFAULT_RULE carries the spec values and a positive derived local gap', () => {
  assert.equal(DEFAULT_RULE.maxRanks, 2);
  assert.equal(DEFAULT_RULE.minSimilarity, 0.45);
  assert.ok(Number.isFinite(DEFAULT_RULE.localMinGap) && DEFAULT_RULE.localMinGap > 0);
  assert.ok(Object.isFrozen(DEFAULT_RULE));
});

test('hosted: ranks 1 and 2 with similarity at or above the minimum pass', () => {
  assert.deepEqual(passes(hosted(1, 2, 0.46), 'hosted'), { pass: true, reason: 'ok' });
  assert.deepEqual(passes(hosted(2, 2, 0.45), 'hosted'), { pass: true, reason: 'ok' });
});

test('hosted: a rank above maxRanks fails with ranks, whatever the similarity', () => {
  assert.deepEqual(passes(hosted(1, 3, 0.9), 'hosted'), { pass: false, reason: 'ranks' });
  assert.deepEqual(passes(hosted(3, 3, 0.9), 'hosted'), { pass: false, reason: 'ranks' });
});

test('hosted: low similarity fails with similarity', () => {
  assert.deepEqual(passes(hosted(1, 1, 0.44), 'hosted'), { pass: false, reason: 'similarity' });
});

test('hosted: a vector rank 1 without an fts rank passes only at minSimilarity + 0.05', () => {
  assert.deepEqual(passes(hosted(null, 1, 0.51), 'hosted'), { pass: true, reason: 'ok' });
  assert.deepEqual(passes(hosted(null, 1, 0.5), 'hosted'), { pass: true, reason: 'ok' });
  assert.deepEqual(passes(hosted(null, 1, 0.49), 'hosted'), { pass: false, reason: 'similarity' });
  assert.equal(passes(hosted(null, 2, 0.9), 'hosted').pass, false);
  assert.equal(passes(hosted(null, 2, 0.9), 'hosted').reason, 'ranks');
});

test('hosted: a vector rank 1 passes the vector rule even when the fts rank is above maxRanks', () => {
  assert.deepEqual(passes(hosted(5, 1, 0.55), 'hosted'), { pass: true, reason: 'ok' });
});

test('hosted: a null comparison is false', () => {
  assert.equal(passes(hosted(1, 1, null), 'hosted').pass, false);
  assert.equal(passes(hosted(null, null, 0.9), 'hosted').pass, false);
  assert.equal(passes(hosted(1, null, 0.9), 'hosted').pass, false);
  assert.equal(passes({}, 'hosted').pass, false);
});

test('hosted: a custom rule changes the thresholds', () => {
  const rule = { maxRanks: 1, minSimilarity: 0.6 };
  assert.equal(passes(hosted(1, 2, 0.9), 'hosted', rule).pass, false);
  assert.equal(passes(hosted(1, 1, 0.59), 'hosted', rule).pass, false);
  assert.equal(passes(hosted(1, 1, 0.6), 'hosted', rule).pass, true);
});

test('local: rank 1 with a gap at or above localMinGap passes', () => {
  const min = DEFAULT_RULE.localMinGap;
  assert.deepEqual(passes(local(1, min), 'local'), { pass: true, reason: 'ok' });
  assert.deepEqual(passes(local(1, min + 5), 'local'), { pass: true, reason: 'ok' });
});

test('local: rank 1 with a smaller gap fails with gap', () => {
  assert.deepEqual(passes(local(1, DEFAULT_RULE.localMinGap - 0.01), 'local'), { pass: false, reason: 'gap' });
  assert.deepEqual(passes(local(1, 0, 5), 'local'), { pass: false, reason: 'gap' });
});

test('local: a null gap passes with two matched terms and fails with fewer', () => {
  assert.deepEqual(passes(local(1, null, 2), 'local'), { pass: true, reason: 'ok' });
  assert.deepEqual(passes(local(1, null, 3), 'local'), { pass: true, reason: 'ok' });
  assert.deepEqual(passes(local(1, null, 1), 'local'), { pass: false, reason: 'terms' });
  assert.deepEqual(passes(local(1, null, null), 'local'), { pass: false, reason: 'terms' });
  assert.deepEqual(passes({ table_rank: 1 }, 'local'), { pass: false, reason: 'terms' });
});

test('local: any row below rank 1 fails with not-top', () => {
  assert.deepEqual(passes(local(2, 100, 5), 'local'), { pass: false, reason: 'not-top' });
  assert.deepEqual(passes(local(null, 100, 5), 'local'), { pass: false, reason: 'not-top' });
});

test('local: a custom localMinGap is honored', () => {
  assert.equal(passes(local(1, 1.5), 'local', { localMinGap: 2 }).pass, false);
  assert.equal(passes(local(1, 2), 'local', { localMinGap: 2 }).pass, true);
});

test('local: a null localMinGap in the rule means the default, never no constraint', () => {
  assert.equal(passes(local(1, 0), 'local', { localMinGap: null }).pass, false);
  assert.equal(passes(local(1, DEFAULT_RULE.localMinGap), 'local', { localMinGap: null }).pass, true);
});

test('an unknown mode throws', () => {
  assert.throws(() => passes(local(1, 5), 'cloud'), /mode/);
});

test('resolveRule replaces null and absent values with the defaults, never zero', () => {
  assert.deepEqual(resolveRule({ localMinGap: null }), DEFAULT_RULE);
  assert.deepEqual(resolveRule({ maxRanks: null, minSimilarity: null, localMinGap: null }), DEFAULT_RULE);
  assert.deepEqual(resolveRule(undefined), DEFAULT_RULE);
  assert.deepEqual(resolveRule(null), DEFAULT_RULE);
  assert.deepEqual(resolveRule({}), DEFAULT_RULE);
  assert.notEqual(resolveRule({ localMinGap: null }).localMinGap, 0);
  assert.deepEqual(resolveRule({ maxRanks: 3, localMinGap: 1 }), { maxRanks: 3, minSimilarity: 0.45, localMinGap: 1 });
});

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));

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

const PLANTED = [{
  slug: 'quokka-wrangler', name: 'Quokka wrangler', description: 'Wrangle quokkas across the outback',
  body: 'Quokka wrangling procedure for the outback. Quokka quokka quokka.',
}];

localTest('buildSyntheticVault is deterministic per seed, a valid vault, and finds planted skills', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dirs = [await tempDir('sv-a-'), await tempDir('sv-b-')];
  const found = [];
  for (const dir of dirs) {
    await buildSyntheticVault(dir, { skills: 25, seed: 3, planted: PLANTED });
    const opened = openVaultReadOnly({ dir, DatabaseSync });
    assert.equal(opened.ok, true, 'opens read-only: migrations are applied');
    const { db } = opened;
    try {
      const rows = await createSqliteRepo(db).searchSignals('wrangle quokkas outback', {});
      found.push(rows.map((r) => [r.slug, r.table_rank, r.bm25]));
      assert.equal(rows[0].slug, 'quokka-wrangler');
      assert.equal(rows[0].table_rank, 1);
      assert.equal(db.prepare('select count(*) as n from skills').get().n, 26);
    } finally {
      db.close();
    }
  }
  assert.deepEqual(found[0], found[1], 'same seed, same vault');
  // sha256 comes from the seed and the index, not from earlier calls in the process.
  const digests = [];
  for (const dir of dirs) {
    const o = openVaultReadOnly({ dir, DatabaseSync });
    digests.push(o.db.prepare('select sha256 from versions order by id').all().map((r) => r.sha256));
    o.db.close();
  }
  assert.deepEqual(digests[0], digests[1]);
});

localTest('HEADJACK_HOME=<dir> makes the CLI search the synthetic vault', async () => {
  const dir = await tempDir('sv-home-');
  const home = await tempDir('sv-uhome-');
  await buildSyntheticVault(dir, { skills: 10, seed: 5, planted: PLANTED });
  const res = await runCli(['search', 'wrangle quokkas outback'], { HOME: home, HEADJACK_HOME: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /quokka-wrangler/);
});

test('synthetic queries are two distinct words and deterministic', () => {
  const queries = syntheticQueries({ count: 200 });
  assert.deepEqual(queries, syntheticQueries({ count: 200 }));
  for (const q of queries) {
    const [a, b, ...rest] = q.split(' ');
    assert.ok(a && b && rest.length === 0 && a !== b, q);
  }
});

localTest('at most one in ten random two-word queries passes the local rule at DEFAULT_RULE.localMinGap', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-cal-');
  await buildSyntheticVault(dir);
  const opened = openVaultReadOnly({ dir, DatabaseSync });
  assert.equal(opened.ok, true);
  try {
    const rows = await rankOneRows(createSqliteRepo(opened.db), syntheticQueries({ count: QUERIES }));
    const fraction = passFraction(rows, DEFAULT_RULE.localMinGap);
    assert.ok(fraction <= MAX_PASS_FRACTION, `pass fraction ${fraction}`);
    assert.ok(fraction > 0, 'the default is not so strict that nothing passes');
  } finally {
    opened.db.close();
  }
});
