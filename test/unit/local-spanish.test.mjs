import assert from 'node:assert/strict';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';

let sha = 0;
function version(slug, extra = {}) {
  sha += 1;
  return {
    manifest: {
      slug, name: slug, description: `${slug} description`, kind: 'skill', plugin_slug: null, tags: [],
      source: { kind: 'local' }, sha256: String(sha).padStart(64, '0'), status: extra.status ?? 'approved',
      review_notes: 'ok', scan_flags: [],
    },
    tarball: null,
    chunks: [{ text: `${slug} body`, kind: 'content' }],
  };
}

async function fixture() {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-spanish-');
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  const { skillId, versionId } = await repo.publish(version('mixer'));
  // The FTS5 row for a skill, matched through the table's own column; null when the skill has no row.
  const ftsRow = (id = skillId) => {
    const row = db.prepare('select queries from skill_docs_es where rowid = ?').get(id);
    return row ? { ...row } : null;
  };
  return { db, repo, skillId, versionId, ftsRow };
}

localTest('setSpanish on the current version writes the column, enrichment_v and the FTS row, and getSkill reads them', async () => {
  const { db, repo, skillId, versionId, ftsRow } = await fixture();
  try {
    assert.equal(await repo.setSpanish(skillId, versionId, 'mezclar pistas de audio', 2), true);
    const skill = await repo.getSkill('mixer');
    assert.equal(skill.queries_es_text, 'mezclar pistas de audio');
    assert.equal(skill.enrichment_v, 2);
    assert.deepEqual(ftsRow(), { queries: 'mezclar pistas de audio' });
    // The table is searchable with accents folded and no stemming.
    const hit = db.prepare('select rowid as id from skill_docs_es where skill_docs_es match ?').all('"mezclár"');
    assert.deepEqual(hit.map((r) => r.id), [skillId]);
  } finally {
    db.close();
  }
});

localTest('setSpanish on a version that is not the current one returns false and writes nothing', async () => {
  const { db, repo, skillId, versionId, ftsRow } = await fixture();
  try {
    assert.equal(await repo.setSpanish(skillId, versionId + 100, 'texto viejo', 1), false);
    const skill = await repo.getSkill('mixer');
    assert.equal(skill.queries_es_text, '');
    assert.equal(skill.enrichment_v, null);
    assert.equal(ftsRow(), null);
    assert.equal(await repo.setSpanish(skillId + 100, versionId, 'sin habilidad', 1), false);
    assert.equal(ftsRow(skillId + 100), null);
  } finally {
    db.close();
  }
});

localTest('setSpanish with an empty text clears the column and deletes the FTS row; enrichment_v is always null', async () => {
  const { db, repo, skillId, versionId, ftsRow } = await fixture();
  try {
    await repo.setSpanish(skillId, versionId, 'primero', 1);
    assert.equal(await repo.setSpanish(skillId, versionId, '', 2), true, 'an empty text with a version still stores null');
    const skill = await repo.getSkill('mixer');
    assert.equal(skill.queries_es_text, '');
    assert.equal(skill.enrichment_v, null);
    assert.equal(ftsRow(), null);
    // Writing again after a clear replaces nothing stale: one row only.
    await repo.setSpanish(skillId, versionId, 'segundo', 1);
    await repo.setSpanish(skillId, versionId, 'tercero', 1);
    assert.equal(db.prepare('select count(*) as n from skill_docs_es').get().n, 1);
    assert.deepEqual(ftsRow(), { queries: 'tercero' });
  } finally {
    db.close();
  }
});

localTest('publish of a new approved version clears the Spanish data so --stale picks the skill up; a rejected one does not', async () => {
  const { db, repo, skillId, versionId, ftsRow } = await fixture();
  try {
    await repo.setSpanish(skillId, versionId, 'mezclar pistas', 1);

    await repo.publish(version('mixer', { status: 'rejected' }));
    const kept = await repo.getSkill('mixer');
    assert.equal(kept.queries_es_text, 'mezclar pistas');
    assert.equal(kept.enrichment_v, 1);
    assert.deepEqual(ftsRow(), { queries: 'mezclar pistas' });

    const next = await repo.publish(version('mixer'));
    assert.equal(next.skillId, skillId);
    assert.notEqual(next.versionId, versionId);
    const cleared = await repo.getSkill('mixer');
    assert.equal(cleared.queries_es_text, '');
    assert.equal(cleared.enrichment_v, null);
    assert.equal(ftsRow(), null);
    // The old version is no longer current, so a late write for it is refused.
    assert.equal(await repo.setSpanish(skillId, versionId, 'tarde', 1), false);
    assert.equal(await repo.setSpanish(skillId, next.versionId, 'a tiempo', 1), true);
  } finally {
    db.close();
  }
});

localTest('listEnrichTargets: default is skills without Spanish text; slugs and stale narrow it; it reads the current body', async () => {
  const { db, repo, skillId, versionId } = await fixture();
  try {
    const old = await repo.publish(version('old-v0'));
    await repo.setSpanish(old.skillId, old.versionId, 'texto de una version vieja', 0);
    const fresh = await repo.publish(version('fresh-v1'));
    await repo.setSpanish(fresh.skillId, fresh.versionId, 'texto al dia', 1);
    await repo.publish(version('rejected-only', { status: 'rejected' }));

    const slugs = (rows) => rows.map((r) => r.slug);
    // Default: Spanish text still empty (mixer only); a rejected-only skill has no current version and never shows.
    assert.deepEqual(slugs(await repo.listEnrichTargets({})), ['mixer']);
    // --stale: enrichment_v null or older than the current version of the prompt (1).
    assert.deepEqual(slugs(await repo.listEnrichTargets({ stale: true })), ['mixer', 'old-v0']);
    // Explicit slugs ignore the empty-text default, and stale still narrows them.
    assert.deepEqual(slugs(await repo.listEnrichTargets({ slugs: ['fresh-v1', 'mixer'] })), ['mixer', 'fresh-v1']);
    assert.deepEqual(slugs(await repo.listEnrichTargets({ slugs: ['fresh-v1', 'mixer'], stale: true })), ['mixer']);
    assert.deepEqual(await repo.listEnrichTargets({ slugs: ['nope', 'rejected-only'] }), []);

    const [row] = await repo.listEnrichTargets({ slugs: ['mixer'] });
    assert.deepEqual({ ...row }, {
      id: skillId, version_id: versionId, slug: 'mixer', name: 'mixer', description: 'mixer description',
      body: 'mixer body', enrichment_v: null,
    });
  } finally {
    db.close();
  }
});
