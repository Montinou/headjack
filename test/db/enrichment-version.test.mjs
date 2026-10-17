// skills.enrichment_v (spec §6.3): the migration marks existing Spanish text as version 1, every write of
// queries_es_text sets the current ENRICHMENT_VERSION (non-empty) or null (''), and the backfill's --stale listing
// selects rows whose version is null or older than the current one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { repoForOwner } from '../../lib/repo.mjs';
import { ENRICHMENT_VERSION } from '../../lib/enrich-prompt.mjs';
import { tempDir } from '../helpers.mjs';
import { localSupported, localTest } from '../local-helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { appPool, closePg, migrateThrough, migratedPg, newPg, rowsOf, vec } from '../pglite.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};

const manifest = (slug, i, extra = {}) => ({
  slug, name: slug, description: `${slug} description`, kind: 'skill', tags: [],
  source: { kind: 'github', url: 'https://github.com/x/y' }, source_path: `skills/${slug}`,
  commit_sha: 'a'.repeat(40), sha256: String(i).repeat(64), status: 'approved', review_notes: 'ok', scan_flags: [], ...extra,
});
const chunk = (i) => [{ text: `chunk ${i}`, embedding: vec(i) }];

async function setup() {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'enrichment-v'));
  return { pg, repo };
}
const versionOf = async (pg, slug) => (await rowsOf(pg)('select enrichment_v from skills where slug = $1', [slug]))[0].enrichment_v;

test('enrichment migration sets enrichment_v = 1 where queries_es_text is non-empty and leaves null for empty', async () => {
  const pg = await newPg();
  try {
    await migrateThrough(pg, '0009_');
    const db = createDb(appPool(pg));
    const owner = await db.resolveOwner('user', 'pre-migration');
    await db.withOwner(owner, (tx) => tx.query(
      `insert into skills (slug, name, description, kind, queries_es_text)
       values ('enriched', 'e', 'd', 'skill', 'mezclar pistas'), ('plain', 'p', 'd', 'skill', '')`,
    ));
    await migrateThrough(pg);
    const rows = await rowsOf(pg)('select slug, enrichment_v from skills order by slug');
    assert.deepEqual(rows, [{ slug: 'enriched', enrichment_v: 1 }, { slug: 'plain', enrichment_v: null }]);
  } finally {
    await closePg(pg);
  }
});

test('enrichment_v: publish with Spanish queries sets the current version; without them (failed enrichment) null', async () => {
  const { pg, repo } = await setup();
  try {
    await repo.publish({ manifest: manifest('es', 1), tarball: null, chunks: chunk(0), queriesEs: ['mezclar pistas'] });
    await repo.publish({ manifest: manifest('none', 2), tarball: null, chunks: chunk(1), queriesEs: null });
    assert.equal(await versionOf(pg, 'es'), ENRICHMENT_VERSION);
    assert.equal(await versionOf(pg, 'none'), null);
    // A new approved version whose enrichment failed clears the text and the version.
    await repo.publish({ manifest: manifest('es', 3), tarball: null, chunks: chunk(2), queriesEs: [] });
    assert.equal(await versionOf(pg, 'es'), null);
  } finally {
    await closePg(pg);
  }
});

test('enrichment_v: addQueryChunks and setQueriesEs set the current version for text and null for empty', async () => {
  const { pg, repo } = await setup();
  try {
    await repo.publish({ manifest: manifest('a', 1), tarball: null, chunks: chunk(0), queriesEs: null });
    await repo.publish({ manifest: manifest('b', 2), tarball: null, chunks: chunk(1), queriesEs: ['algo'] });
    const [a] = await repo.listEnrichmentTargets({ only: ['a'] });
    assert.equal(await repo.addQueryChunks({ skillId: a.skill_id, versionId: a.version_id, chunks: chunk(3), tags: [], queriesEs: ['uno', 'dos'] }), true);
    assert.equal(await versionOf(pg, 'a'), ENRICHMENT_VERSION);
    assert.equal(await repo.addQueryChunks({ skillId: a.skill_id, versionId: a.version_id, chunks: chunk(3), tags: [], queriesEs: null }), true);
    assert.equal(await versionOf(pg, 'a'), null);

    const [b] = await repo.listQueriesEsTargets({ force: true, only: ['b'] });
    assert.equal(await repo.setQueriesEs(b.skill_id, b.version_id, ''), true);
    assert.equal(await versionOf(pg, 'b'), null);
    assert.equal(await repo.setQueriesEs(b.skill_id, b.version_id, 'texto nuevo'), true);
    assert.equal(await versionOf(pg, 'b'), ENRICHMENT_VERSION);
  } finally {
    await closePg(pg);
  }
});

test('enrichment_v: getSkill (skill detail) returns queries_es_text and enrichment_v', async () => {
  const { pg, repo } = await setup();
  try {
    await repo.publish({ manifest: manifest('es', 1), tarball: null, chunks: chunk(0), queriesEs: ['mezclar pistas', 'equilibrar niveles'] });
    await repo.publish({ manifest: manifest('none', 2), tarball: null, chunks: chunk(1), queriesEs: null });
    const es = await repo.getSkill('es');
    assert.equal(es.queries_es_text, 'mezclar pistas equilibrar niveles');
    assert.equal(es.enrichment_v, ENRICHMENT_VERSION);
    const none = await repo.getSkill('none');
    assert.equal(none.queries_es_text, '');
    assert.equal(none.enrichment_v, null);
  } finally {
    await closePg(pg);
  }
});

test('enrichment_v: listQueriesEsTargets with stale selects null and older versions only', async () => {
  const { pg, repo } = await setup();
  try {
    await repo.publish({ manifest: manifest('current', 1), tarball: null, chunks: chunk(0), queriesEs: ['al día'] });
    await repo.publish({ manifest: manifest('missing', 2), tarball: null, chunks: chunk(1), queriesEs: null });
    await repo.publish({ manifest: manifest('older', 3), tarball: null, chunks: chunk(2), queriesEs: ['viejo'] });
    // An older prompt version (written by hand: no write path produces one while ENRICHMENT_VERSION is current).
    await pg.query("update skills set enrichment_v = $1 where slug = 'older'", [ENRICHMENT_VERSION - 1]);
    const stale = await repo.listQueriesEsTargets({ stale: true });
    assert.deepEqual(stale.map((t) => t.slug), ['missing', 'older']);
    assert.deepEqual(stale.map((t) => t.has_text), [false, true]);
    assert.deepEqual((await repo.listQueriesEsTargets({ stale: true, only: ['older', 'current'] })).map((t) => t.slug), ['older']);
    assert.deepEqual((await repo.listQueriesEsTargets({})).map((t) => t.slug), ['missing'], 'without stale only empty text');
  } finally {
    await closePg(pg);
  }
});

localTest('enrichment_v: local repo getSkill returns queries_es_text "" and enrichment_v null until Phase 7', async () => {
  const db = openVault({ dir: await tempDir('sv-enrich-v-'), DatabaseSync });
  try {
    const repo = createSqliteRepo(db);
    await repo.publish({ manifest: manifest('es', 1), tarball: Buffer.from('t'), chunks: chunk(0), queriesEs: ['mezclar pistas'] });
    const s = await repo.getSkill('es');
    assert.equal(s.queries_es_text, '');
    assert.equal(s.enrichment_v, null);
  } finally {
    db.close();
  }
});
