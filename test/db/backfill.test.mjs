// The Spanish query text backfill against the migrated schema, as the app role for one owner (RLS FORCE applies):
// it writes skills.queries_es_text and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { repoForOwner } from '../../lib/repo.mjs';
import { backfillQueriesEs } from '../../lib/backfill.mjs';
import { pack } from '../../lib/tar.mjs';
import { file, captureLog } from '../helpers.mjs';
import { appPool, migratedPg, vec } from '../pglite.mjs';

const manifest = (slug, i, extra = {}) => ({
  slug, name: slug, description: `${slug} description`, kind: 'skill', tags: ['audio', 'podcast'],
  source: { kind: 'github', url: 'https://github.com/x/y' }, source_path: `skills/${slug}`,
  commit_sha: 'a'.repeat(40), sha256: String(i).repeat(64), status: 'approved', review_notes: 'ok', scan_flags: [], ...extra,
});
const tarball = (slug) => pack([file('SKILL.md', `---\nname: ${slug}\ndescription: d\n---\n# ${slug} body`)]);

async function setup() {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-a'));
  const other = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-b'));
  await repo.publish({ manifest: manifest('mastering', 1), tarball: tarball('mastering'), chunks: [{ text: 'master audio', embedding: vec(0) }], queriesEs: null });
  await repo.publish({ manifest: manifest('mixing', 2), tarball: tarball('mixing'), chunks: [{ text: 'mix tracks', embedding: vec(1) }], queriesEs: ['mezclar pistas de audio', 'equilibrar niveles'] });
  await repo.publish({ manifest: manifest('noise', 3), tarball: tarball('noise'), chunks: [{ text: 'remove noise', embedding: vec(2) }], queriesEs: null });
  await repo.publish({ manifest: manifest('never-current', 4, { status: 'rejected' }), tarball: null, chunks: [] });
  await other.publish({ manifest: manifest('elsewhere', 5), tarball: tarball('elsewhere'), chunks: [{ text: 'other owner', embedding: vec(3) }], queriesEs: null });
  return { pg, repo, other };
}

// Everything the backfill must leave alone, read as the superuser (all owners).
async function untouched(pg) {
  const skills = await pg.query('select slug, tags, tags_text, fts::text as fts, current_version_id, description, name from skills order by slug');
  const chunks = await pg.query('select skill_id, version_id, text, kind, embedding::text as embedding from chunks order by id');
  const versions = await pg.query('select id, skill_id, sha256, status from versions order by id');
  return { skills: skills.rows, chunks: chunks.rows, versions: versions.rows };
}
const spanishText = async (pg) => Object.fromEntries((await pg.query('select slug, queries_es_text from skills order by slug')).rows.map((r) => [r.slug, r.queries_es_text]));

const fakeEnrichEs = async (s) => ({ queries_es: [`masterizar ${s.name}`, 'limpiar la voz grabada'], usage: { inputTokens: 50, outputTokens: 10 } });

test('listQueriesEsTargets lists current versions with empty text (all with force), filters by slug and flags has_text', async () => {
  const { repo } = await setup();
  const empty = await repo.listQueriesEsTargets({});
  assert.deepEqual(empty.map((t) => t.slug), ['mastering', 'noise'], 'no rejected-only skill, no other owner, no skill with text');
  assert.equal(typeof empty[0].skill_id, 'number');
  assert.equal(typeof empty[0].version_id, 'number');
  assert.deepEqual(
    Object.fromEntries(Object.entries(empty[0]).filter(([k]) => ['slug', 'name', 'description', 'kind', 'plugin_slug', 'has_text'].includes(k))),
    { slug: 'mastering', name: 'mastering', description: 'mastering description', kind: 'skill', plugin_slug: null, has_text: false },
  );
  const all = await repo.listQueriesEsTargets({ force: true });
  assert.deepEqual(all.map((t) => [t.slug, t.has_text]), [['mastering', false], ['mixing', true], ['noise', false]]);
  assert.deepEqual((await repo.listQueriesEsTargets({ force: true, only: ['mixing', 'nope'] })).map((t) => t.slug), ['mixing']);
  assert.deepEqual(await repo.listQueriesEsTargets({ only: ['mixing'] }), []);
});

test('setQueriesEs writes only that skill\'s text and returns whether a row was updated (owner-scoped)', async () => {
  const { pg, repo, other } = await setup();
  const [target] = await repo.listQueriesEsTargets({ only: ['noise'] });
  const [foreign] = await other.listQueriesEsTargets({});
  const before = await untouched(pg);
  assert.equal(await repo.setQueriesEs(target.skill_id, target.version_id, 'quitar ruido de fondo'), true);
  assert.equal(await repo.setQueriesEs(foreign.skill_id, foreign.version_id, 'no es mío'), false, 'another owner\'s skill is invisible');
  assert.equal(await repo.setQueriesEs(999999, target.version_id, 'nadie'), false);
  assert.deepEqual(await untouched(pg), before);
  const text = await spanishText(pg);
  assert.equal(text.noise, 'quitar ruido de fondo');
  assert.equal(text.elsewhere, '');
  assert.equal(text.mastering, '');
});

test('backfillQueriesEs writes only queries_es_text; counts before and after; a second run fills nothing; force rewrites', async () => {
  const { pg, repo } = await setup();
  const before = await untouched(pg);
  const out = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs, log: captureLog() });
  assert.deepEqual(out.before, { total: 3, withText: 1 });
  assert.deepEqual(out.after, { total: 3, withText: 3 });
  assert.deepEqual(out.filled.sort(), ['mastering', 'noise']);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(await untouched(pg), before, 'chunks, tags, fts, versions unchanged');
  const text = await spanishText(pg);
  assert.equal(text.mastering, 'masterizar mastering limpiar la voz grabada');
  assert.equal(text.mixing, 'mezclar pistas de audio equilibrar niveles', 'non-empty text skipped without force');
  assert.equal(text.elsewhere, '', 'another owner untouched');
  const { rows } = await pg.query("select slug from skills where fts_es @@ to_tsquery('spanish', 'masterizar') order by slug");
  assert.deepEqual(rows.map((r) => r.slug), ['mastering', 'noise'], 'the generated Spanish tsvector follows the text');

  const again = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs, log: captureLog() });
  assert.deepEqual(again.filled, []);
  assert.deepEqual(again.before, { total: 3, withText: 3 });
  assert.deepEqual(again.usage, { inputTokens: 0, outputTokens: 0 });

  const forced = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs, log: captureLog(), force: true, only: ['mixing'] });
  assert.deepEqual(forced.filled, ['mixing']);
  assert.equal((await spanishText(pg)).mixing, 'masterizar mixing limpiar la voz grabada');
  assert.deepEqual(await untouched(pg), before);
});

test('backfillQueriesEs --dry-run writes nothing and reports after equal to before', async () => {
  const { pg, repo } = await setup();
  const before = { ...(await untouched(pg)), text: await spanishText(pg) };
  const out = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs, log: captureLog(), dryRun: true });
  assert.deepEqual(out.before, { total: 3, withText: 1 });
  assert.deepEqual(out.after, out.before);
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 20 });
  assert.deepEqual({ ...(await untouched(pg)), text: await spanishText(pg) }, before);
});

test('backfillQueriesEs: a failing skill lands in failed and the rest are written', async () => {
  const { pg, repo } = await setup();
  const enrichEs = async (s) => { if (s.name === 'mastering') throw new Error('gateway down'); return fakeEnrichEs(s); };
  const out = await backfillQueriesEs({ repo, enrichEs, log: captureLog() });
  assert.deepEqual(out.failed, [{ slug: 'mastering', reason: 'gateway down' }]);
  assert.deepEqual(out.filled, ['noise']);
  assert.deepEqual(out.after, { total: 3, withText: 2 });
  assert.deepEqual(out.usage, { inputTokens: 50, outputTokens: 10 });
  assert.equal((await spanishText(pg)).mastering, '');
});

test('setQueriesEs writes nothing when the version passed is no longer current', async () => {
  const { pg, repo } = await setup();
  const [target] = await repo.listQueriesEsTargets({ only: ['noise'] });
  await repo.publish({ manifest: manifest('noise', 6), tarball: tarball('noise'), chunks: [{ text: 'remove noise v2', embedding: vec(4) }], queriesEs: ['texto nuevo de la versión dos'] });
  assert.equal(await repo.setQueriesEs(target.skill_id, target.version_id, 'texto viejo'), false);
  assert.equal((await spanishText(pg)).noise, 'texto nuevo de la versión dos');
});

test('backfillQueriesEs: a version published between listing and writing keeps its text and the slug is skipped', async () => {
  const { pg, repo } = await setup();
  const enrichEs = async (s) => {
    if (s.name === 'noise') {
      await repo.publish({ manifest: manifest('noise', 6), tarball: tarball('noise'), chunks: [{ text: 'remove noise v2', embedding: vec(4) }], queriesEs: ['texto nuevo de la versión dos'] });
    }
    return fakeEnrichEs(s);
  };
  const out = await backfillQueriesEs({ repo, enrichEs, log: captureLog() });
  assert.deepEqual(out.skipped, ['noise']);
  assert.deepEqual(out.filled, ['mastering']);
  const text = await spanishText(pg);
  assert.equal(text.noise, 'texto nuevo de la versión dos', 'the stale text never replaces the newer version\'s');
  assert.equal(text.mastering, 'masterizar mastering limpiar la voz grabada');
});
