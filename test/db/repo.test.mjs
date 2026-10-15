// The former test/integration/repo.test.mjs (needed a disposable Neon branch), now on PGlite as headjack_app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { repoForOwner } from '../../lib/repo.mjs';
import { ConflictError } from '../../lib/errors.mjs';
import { markBaseline } from '../../db/baseline.mjs';
import { appPool, migratedPg, migrateThrough, MIGRATIONS, rowsOf, v1Database, vec } from '../pglite.mjs';

const GF = 'grandfathered: instalada antes del vault, no revisada';

test('repo against the migrated schema, as the app role for one owner', async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'legacy:v1'));
  const base = {
    slug: 'remotion-render', name: 'remotion-render', description: 'Export a Remotion video', kind: 'skill', tags: [],
    source: { kind: 'github', url: 'https://github.com/x/y' }, source_path: 'skills/remotion-render',
    commit_sha: 'a'.repeat(40), sha256: '1'.repeat(64), status: 'approved', review_notes: 'ok', scan_flags: [],
  };
  const r1 = await repo.publish({ manifest: base, tarball: Buffer.from('tgz'), chunks: [{ text: 'remotion render', embedding: vec(0) }] });
  assert.ok(r1.skillId > 0);

  const s = await repo.getSkill('remotion-render');
  assert.equal(s.sha256, base.sha256);
  assert.equal(s.source_url, 'https://github.com/x/y');
  assert.equal(await repo.getSkill('nope'), null);

  assert.deepEqual(await repo.searchText('remotion', 5), [r1.skillId]);
  const byVector = await repo.searchVector(vec(0), 5);
  assert.deepEqual(byVector.map((r) => r.id), [r1.skillId]);
  assert.equal(typeof byVector[0].sim, 'number');
  assert.ok(Math.abs(byVector[0].sim - 1) < 1e-9, 'sim is the cosine similarity of the best chunk');
  const [row] = await repo.getSkillsByIds([r1.skillId]);
  assert.equal(row.slug, 'remotion-render');
  assert.equal(row.update_available, false);

  await assert.rejects(repo.publish({ manifest: base, tarball: Buffer.from('tgz'), chunks: [] }), ConflictError);
  assert.equal(await repo.versionExists('remotion-render', base.sha256), true);

  await repo.publish({ manifest: { ...base, sha256: '2'.repeat(64), status: 'rejected' }, tarball: null, chunks: [] });
  assert.equal((await repo.getSkill('remotion-render')).sha256, base.sha256, 'rejected must not become current');
  const versions = await repo.listVersions('remotion-render');
  assert.equal(versions.length, 2);
  assert.equal(versions.find((v) => v.current).sha256, base.sha256);

  const tb = await repo.getTarball('remotion-render');
  assert.equal(Buffer.from(tb.tarball).toString(), 'tgz');

  const targets = await repo.listUpstreamTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].source_path, 'skills/remotion-render');
  await repo.markUpstream(targets[0].skill_id, 'b'.repeat(40), false);
  assert.deepEqual((await repo.listUpdates({})).map((u) => u.slug), [], 'a new commit without a path change is not an update');
  await repo.markUpstream(targets[0].skill_id, 'b'.repeat(40), true);
  assert.deepEqual((await repo.listUpdates({})).map((u) => u.slug), ['remotion-render']);

  const local = { ...base, source: { kind: 'local' }, commit_sha: null, review_notes: GF };
  await repo.publish({ manifest: { ...local, slug: 'humanizer', name: 'humanizer', description: 'Remove AI writing', sha256: '3'.repeat(64) }, tarball: Buffer.from('x'), chunks: [{ text: 'humanizer', embedding: vec(1) }] });
  await repo.publish({ manifest: { ...local, slug: 'brand-naming', name: 'brand-naming', description: 'Names', sha256: '4'.repeat(64) }, tarball: Buffer.from('y'), chunks: [{ text: 'naming', embedding: vec(2) }] });
  assert.deepEqual((await repo.listUpdates({ grandfathered: true })).map((u) => u.slug), ['brand-naming', 'humanizer']);
  const { rows } = await pg.query("select count(*)::int as n from sources where kind = 'local'");
  assert.equal(rows[0].n, 1, 'local source row is reused');

  const [top] = await repo.searchVector(vec(1), 5);
  assert.equal((await repo.getSkillsByIds([top.id]))[0].slug, 'humanizer');
  assert.equal((await repo.listUpstreamTargets()).length, 1, 'local sources are not upstream targets');

  // Enrichment and audit writes go through the same owner-scoped transactions.
  const [target] = await repo.listEnrichmentTargets({ only: ['humanizer'] });
  assert.equal(await repo.addQueryChunks({ skillId: target.skill_id, versionId: target.version_id, tags: ['writing'], chunks: [{ text: 'q', embedding: vec(3) }] }), true);
  assert.equal(await repo.setAuditMetadata('humanizer', { reuse: 3 }, ['style']), true);
  assert.deepEqual((await repo.getSkill('humanizer')).tags, ['writing', 'style']);
  assert.equal(await repo.setAuditMetadata('nope', { reuse: 1 }, []), false);
});

test('the upstream baseline and review history use the latest reviewed version (approved or rejected), not current_version_id, and are owner-scoped', async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const a = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-a'));
  const b = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-b'));
  const base = {
    slug: 'audit-me', name: 'audit-me', description: 'x', kind: 'skill', tags: [],
    source: { kind: 'github', url: 'https://github.com/x/z' }, source_path: 'skills/audit-me',
    sha256: '5'.repeat(64), status: 'approved', scan_flags: [],
  };
  await a.publish({ manifest: { ...base, commit_sha: 'a'.repeat(40) }, tarball: Buffer.from('t1'), chunks: [{ text: 'x', embedding: vec(4) }] });
  await a.publish({ manifest: { ...base, commit_sha: 'b'.repeat(40), sha256: '6'.repeat(64) }, tarball: Buffer.from('t2'), chunks: [{ text: 'x', embedding: vec(4) }] });
  // Rejected, but the newest reviewed version: it must become the upstream baseline, not the older approved 'b'.
  await a.publish({ manifest: { ...base, commit_sha: 'c'.repeat(40), sha256: '7'.repeat(64), status: 'rejected' }, tarball: null, chunks: [] });

  const [target] = await a.listUpstreamTargets();
  assert.equal(target.commit_sha, 'c'.repeat(40), 'the rejected, most-recently reviewed version is the baseline, not the current approved one');

  const reviews = await a.listReviews('audit-me');
  assert.deepEqual(reviews.map((r) => r.commit_sha), ['c'.repeat(40), 'b'.repeat(40), 'a'.repeat(40)], 'newest first');
  assert.deepEqual(reviews.map((r) => r.status), ['rejected', 'approved', 'approved']);
  assert.deepEqual(reviews.map((r) => r.current), [false, true, false], 'current marks skills.current_version_id, unaffected by later rejections');
  assert.equal(reviews[0].sha256, '7'.repeat(64));

  // listUpdates: reviewed_commit is the baseline ('c', the rejected review); current_commit stays the approved one ('b').
  await a.markUpstream(target.skill_id, 'e'.repeat(40), true);
  const [update] = await a.listUpdates({});
  assert.equal(update.slug, 'audit-me');
  assert.equal(update.reviewed_commit, 'c'.repeat(40));
  assert.equal(update.current_commit, 'b'.repeat(40));
  assert.equal(update.latest_commit, 'e'.repeat(40));

  await b.publish({ manifest: { ...base, commit_sha: 'd'.repeat(40), sha256: '8'.repeat(64) }, tarball: Buffer.from('t3'), chunks: [{ text: 'x', embedding: vec(4) }] });
  assert.deepEqual((await b.listReviews('audit-me')).map((r) => r.commit_sha), ['d'.repeat(40)], "owner b's own same-slug skill never surfaces owner a's reviews");
  assert.equal((await a.listReviews('audit-me')).length, 3, "owner a's review history is unaffected by owner b publishing the same slug");

  const targetsA = await a.listUpstreamTargets();
  assert.equal(targetsA.length, 1, "owner b publishing the same slug never adds a second target to owner a's list");
  assert.equal(targetsA[0].commit_sha, 'c'.repeat(40), "owner a's baseline is unaffected by owner b's version of the same slug");
});

test('a locally-reviewed rejection with no commit_sha never becomes the upstream baseline', async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-null-baseline'));
  const base = {
    slug: 'null-baseline', name: 'null-baseline', description: 'x', kind: 'skill', tags: [],
    source: { kind: 'github', url: 'https://github.com/x/nb' }, source_path: 'skills/null-baseline',
    sha256: '9'.repeat(64), status: 'approved', scan_flags: [],
  };
  await repo.publish({ manifest: { ...base, commit_sha: 'a'.repeat(40) }, tarball: Buffer.from('t'), chunks: [{ text: 'x', embedding: vec(5) }] });
  // A local review with no commit_sha (e.g. a manual re-review) must not clobber the baseline with null.
  await repo.publish({ manifest: { ...base, commit_sha: null, sha256: 'a'.repeat(64), status: 'rejected' }, tarball: null, chunks: [] });
  const [target] = await repo.listUpstreamTargets();
  assert.equal(target.commit_sha, 'a'.repeat(40), 'the baseline stays the last reviewed version that has a commit_sha');
});

test('an approved grandfathered skill (no version has a commit_sha) is still an upstream target, with commit_sha null', async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-grandfathered-target'));
  await repo.publish({
    manifest: {
      slug: 'grandfathered-gh', name: 'grandfathered-gh', description: 'x', kind: 'skill', tags: [],
      source: { kind: 'github', url: 'https://github.com/x/gf' }, source_path: 'skills/grandfathered-gh',
      commit_sha: null, sha256: 'f'.repeat(64), status: 'approved', review_notes: GF, scan_flags: [],
    },
    tarball: Buffer.from('t'), chunks: [{ text: 'x', embedding: vec(7) }],
  });
  const targets = await repo.listUpstreamTargets();
  assert.equal(targets.length, 1, 'an approved skill with a github source is still a target even when no reviewed version has a commit_sha');
  assert.equal(targets[0].commit_sha, null, 'no reviewed version has a commit, so the baseline is null, exactly as before this fix round');
});

test('a skill with only a rejected version (never approved) is not an upstream target', async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-rejected-only'));
  await repo.publish({
    manifest: {
      slug: 'rejected-only', name: 'rejected-only', description: 'x', kind: 'skill', tags: [],
      source: { kind: 'github', url: 'https://github.com/x/ro' }, source_path: 'skills/rejected-only',
      commit_sha: 'b'.repeat(40), sha256: 'b'.repeat(64), status: 'rejected', scan_flags: [],
    },
    tarball: null, chunks: [],
  });
  assert.deepEqual(await repo.listUpstreamTargets(), [], 'a skill with no current approved version is never an upstream target, matching listUpdates');
});

test("publishing a rejected version resets that skill's upstream notice immediately, without waiting for the next cron", async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-reset-notice'));
  const base = {
    slug: 'flaky-notice', name: 'flaky-notice', description: 'x', kind: 'skill', tags: [],
    source: { kind: 'github', url: 'https://github.com/x/fn' }, source_path: 'skills/flaky-notice',
    sha256: 'c'.repeat(64), status: 'approved', scan_flags: [],
  };
  await repo.publish({ manifest: { ...base, commit_sha: 'a'.repeat(40) }, tarball: Buffer.from('t'), chunks: [{ text: 'x', embedding: vec(6) }] });
  const [target] = await repo.listUpstreamTargets();
  await repo.markUpstream(target.skill_id, 'b'.repeat(40), true);
  assert.deepEqual((await repo.listUpdates({})).map((u) => u.slug), ['flaky-notice'], 'update_available is true before the rejected review');
  await repo.publish({ manifest: { ...base, commit_sha: 'b'.repeat(40), sha256: 'd'.repeat(64), status: 'rejected', review_notes: 'not yet' }, tarball: null, chunks: [] });
  assert.deepEqual((await repo.listUpdates({})).map((u) => u.slug), [], 'a rejected review resets update_available immediately');
});

test('queries_es_text follows the approved version: joined Spanish queries, untouched by a rejection, cleared with its chunks when enrichment is null', async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-es'));
  const base = {
    slug: 'es-text', name: 'es-text', description: 'x', kind: 'skill', tags: [], source: { kind: 'local' },
    sha256: '5'.repeat(64), status: 'approved', scan_flags: [],
  };
  const esText = async () => (await pg.query("select queries_es_text from skills where slug = 'es-text'")).rows[0].queries_es_text;
  const chunkCount = async () => (await pg.query("select count(*)::int as n from chunks c join skills s on s.id = c.skill_id where s.slug = 'es-text'")).rows[0].n;

  const { skillId } = await repo.publish({
    manifest: base, tarball: Buffer.from('t'), queriesEs: ['a b', 'c'],
    chunks: [{ text: 'x', embedding: vec(7) }, { text: 'a b', embedding: vec(8), kind: 'query' }],
  });
  assert.equal(await esText(), 'a b c');

  await repo.publish({ manifest: { ...base, sha256: '6'.repeat(64), status: 'rejected' }, tarball: null, chunks: [], queriesEs: null });
  assert.equal(await esText(), 'a b c', 'a rejected version never touches queries_es_text');

  await repo.publish({ manifest: { ...base, sha256: '7'.repeat(64) }, tarball: Buffer.from('u'), chunks: [], queriesEs: null });
  assert.equal(await esText(), '');
  assert.equal(await chunkCount(), 0);

  const [target] = await repo.listEnrichmentTargets({ only: ['es-text'] });
  assert.equal(await repo.addQueryChunks({
    skillId: target.skill_id, versionId: target.version_id, tags: [], queriesEs: ['hacer una demo', 'otra'],
    chunks: [{ text: 'hacer una demo', embedding: vec(9) }],
  }), true);
  assert.equal(await esText(), 'hacer una demo otra');
  assert.equal(await chunkCount(), 1);

  assert.equal(await repo.addQueryChunks({ skillId, versionId: target.version_id - 1, tags: [], queriesEs: ['vieja'], chunks: [] }), false);
  assert.equal(await esText(), 'hacer una demo otra', 'a stale version writes neither chunks nor text');
});

test('bilingual searchText matches queries_es_text in Spanish, drops filler words case-insensitively and keeps the tags filter', async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-bilingual'));
  const m = (slug, description, sha, tags = []) => ({ slug, name: slug, description, kind: 'skill', tags, source: { kind: 'local' }, sha256: sha, status: 'approved', scan_flags: [] });
  const { skillId: docId } = await repo.publish({
    manifest: m('doc-extract', 'Extract text from documents', '1'.repeat(64), ['documents']), tarball: Buffer.from('a'),
    queriesEs: ['convertir un pdf en texto'], chunks: [{ text: 'extract', embedding: vec(0) }],
  });
  await repo.publish({
    manifest: m('demo-maker', 'Record a product walkthrough', '2'.repeat(64)), tarball: Buffer.from('b'),
    queriesEs: ['quiero hacer una demo'], chunks: [{ text: 'demo', embedding: vec(1) }],
  });

  assert.deepEqual(await repo.searchText('convertir pdf', 5, [], { bilingual: true }), [docId]);
  assert.deepEqual(await repo.searchText('convertir pdf', 5, [], { bilingual: false }), []);
  assert.deepEqual(await repo.searchText('convertir pdf', 5), [], 'bilingual defaults to false');

  assert.deepEqual(await repo.searchText('quiero hacer', 5, [], { bilingual: true }), []);
  assert.deepEqual(await repo.searchText('Quiero HACER', 5, [], { bilingual: true }), [], 'filler words are dropped whatever their case');

  assert.deepEqual(await repo.searchText('convertir pdf', 5, ['documents'], { bilingual: true }), [docId]);
  assert.deepEqual(await repo.searchText('convertir pdf', 5, ['audio'], { bilingual: true }), [], 'the tags filter applies to the Spanish side');
});

test("two owners with the same slug: search, reads and tarballs never cross, and the tarball is stored once", async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const a = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-a'));
  const b = repoForOwner(db.withOwner, await db.resolveOwner('user', 'user-b'));
  const m = (description, sha) => ({ slug: 'twin', name: 'twin', description, kind: 'skill', tags: [], source: { kind: 'local' }, sha256: sha, status: 'approved', scan_flags: [] });
  await a.publish({ manifest: m('alpha pipeline', '1'.repeat(64)), tarball: Buffer.from('same'), chunks: [{ text: 'alpha', embedding: vec(0) }] });
  await b.publish({ manifest: m('zebra pipeline', '1'.repeat(64)), tarball: Buffer.from('same'), chunks: [{ text: 'zebra', embedding: vec(0) }] });
  await b.publish({ manifest: { ...m('private notes', '2'.repeat(64)), slug: 'b-only', name: 'b-only', review_notes: GF }, tarball: Buffer.from('mine'), chunks: [{ text: 'notes', embedding: vec(1) }] });

  assert.equal((await a.getSkill('twin')).description, 'alpha pipeline');
  assert.equal((await b.getSkill('twin')).description, 'zebra pipeline');
  assert.deepEqual(await a.searchText('zebra', 5), []);
  const bIds = (await b.searchVector(vec(1), 50)).map((r) => r.id);
  assert.ok(!(await a.searchVector(vec(1), 50)).some((r) => bIds.includes(r.id)));
  assert.deepEqual(await a.getSkillsByIds(bIds), []);
  assert.equal(await a.getSkill('b-only'), null);
  assert.equal(await a.getTarball('b-only'), null);
  assert.deepEqual(await a.listVersions('b-only'), []);
  assert.equal(await a.versionExists('b-only', '2'.repeat(64)), false);
  assert.deepEqual(await a.listUpdates({ grandfathered: true }), []);
  assert.equal(await a.setAuditMetadata('b-only', { reuse: 0 }, ['x']), false);
  assert.equal(Buffer.from((await a.getTarball('twin')).tarball).toString(), 'same');
  assert.equal((await pg.query('select count(*)::int as n from blobs')).rows[0].n, 2);
});

test('after the stage-1 migration the initial owner reads its v1 data through the app role', async () => {
  const pg = await v1Database();
  await markBaseline(rowsOf(pg), MIGRATIONS);
  await migrateThrough(pg);
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'legacy:v1'));
  assert.equal(Buffer.from((await repo.getTarball('alpha')).tarball).toString('hex'), '1f8b0001');
  assert.deepEqual((await repo.listUpdates({ grandfathered: true })).map((u) => u.slug), ['beta']);
  assert.deepEqual(await repo.searchText('video', 5), [1]);
  assert.equal((await repo.listVersions('beta')).length, 2);
  assert.equal((await repo.getTarball('plug@mkt')).tarball, null);
});
