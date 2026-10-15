import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { createRepo, repoForOwner } from '../../lib/repo.mjs';
import { appPool, migratedPg } from '../pglite.mjs';

let pg, db, a, b, empty, ownerA;
const options = { tags: [], limit: 24, offset: 0 };
const fields = ['slug', 'name', 'description', 'kind', 'plugin_slug', 'tags', 'quality', 'update_available', 'has_approved_version'].sort();
before(async () => {
  pg = await migratedPg();
  db = createDb(appPool(pg));
  ownerA = await db.resolveOwner('user', 'catalog-a');
  a = repoForOwner(db.withOwner, ownerA);
  b = repoForOwner(db.withOwner, await db.resolveOwner('user', 'catalog-b'));
  empty = repoForOwner(db.withOwner, await db.resolveOwner('user', 'catalog-empty'));
  for (const [slug, kind, tags, status, plugin_slug] of [
    ['zeta', 'skill', ['writing', 'threejs'], 'approved', null],
    ['alpha', 'skill', ['writing'], 'approved', null],
    ['rejected', 'skill', ['writing'], 'rejected', null],
    ['plugin', 'plugin', ['writing'], 'approved', null],
    ['contained', 'skill', ['threejs'], 'approved', 'plugin'],
  ]) {
    await a.publish({ manifest: { slug, name: 'Equal name', description: `A ${slug}`, kind, plugin_slug, tags, status, sha256: slug.padEnd(64, 'a'), chunks: [] }, tarball: null, chunks: [] });
  }
  await b.publish({ manifest: { slug: 'alpha', name: 'Equal name', description: 'B private', kind: 'skill', tags: ['writing'], status: 'rejected', sha256: 'b'.repeat(64) }, tarball: null, chunks: [] });
  await db.withOwner(ownerA, tx => tx.query("insert into skills (slug,name,description,kind) values ('unreviewed','A first','Never reviewed','skill')"));
  await a.setAuditMetadata('zeta', { reuse: 3 }, []);
  await db.withOwner(ownerA, tx => tx.query("update upstream set update_available = true where skill_id = (select id from skills where slug = 'zeta')"));
});
after(async () => { await pg?.close(); });

test('catalog includes unreviewed and rejected-only records, ordered by name then slug', async () => {
  const result = await a.listSkills(options);
  assert.equal(result.total, 6);
  assert.deepEqual(result.skills.map(s => s.slug), ['unreviewed', 'alpha', 'contained', 'plugin', 'rejected', 'zeta']);
  assert.deepEqual(result.skills.map(s => s.has_approved_version), [false, true, true, true, false, true]);
});

test('catalog filters kind and requires every requested tag before counting and paginating', async () => {
  const result = await a.listSkills({ kind: 'skill', tags: ['writing'], limit: 1, offset: 1 });
  assert.equal(result.total, 3);
  assert.deepEqual(result.skills.map(s => s.slug), ['rejected']);
  const intersection = await a.listSkills({ ...options, tags: ['writing', 'threejs'] });
  assert.equal(intersection.total, 1);
  assert.deepEqual(intersection.skills.map(s => s.slug), ['zeta']);
  assert.deepEqual((await a.listSkills({ ...options, kind: 'plugin' })).skills.map(s => s.slug), ['plugin']);
});

test('empty and out-of-range catalog pages retain the filtered total', async () => {
  assert.deepEqual(await empty.listSkills(options), { skills: [], total: 0 });
  assert.deepEqual(await a.listSkills({ ...options, tags: ['absent'] }), { skills: [], total: 0 });
  assert.deepEqual(await a.listSkills({ ...options, offset: 6 }), { skills: [], total: 6 });
  assert.deepEqual(await a.listSkills({ ...options, offset: Number.MAX_SAFE_INTEGER }), { skills: [], total: 6 });
});

test('forced RLS scopes both catalog rows and total to the authenticated owner', async () => {
  const result = await b.listSkills(options);
  assert.equal(result.total, 1);
  assert.deepEqual(result.skills.map(s => s.description), ['B private']);
  assert.equal((await a.listSkills(options)).total, 6);
});

test('catalog exposes only allowlisted fields with nullable metadata and truthful update state', async () => {
  const { skills } = await a.listSkills(options);
  for (const skill of skills) assert.deepEqual(Object.keys(skill).sort(), fields);
  const alpha = skills.find(s => s.slug === 'alpha');
  assert.equal(alpha.quality, null);
  assert.equal(alpha.plugin_slug, null);
  assert.equal(alpha.update_available, false);
  const zeta = skills.find(s => s.slug === 'zeta');
  assert.deepEqual(zeta.quality, { reuse: 3 });
  assert.equal(zeta.update_available, true);
});

test('catalog computes page and total in one parameterized SQL statement', async () => {
  const queries = [];
  const result = await db.withOwner(ownerA, tx => createRepo({ query: (sql, params) => {
    queries.push({ sql, params });
    return tx.query(sql, params);
  } }).listSkills({ kind: 'skill', tags: ["writing' OR true --"], limit: 1, offset: 0 }));
  assert.deepEqual(result, { skills: [], total: 0 });
  assert.equal(queries.length, 1);
  assert.ok(queries[0].params.some(p => Array.isArray(p) && p.includes("writing' OR true --")));
  assert.ok(!queries[0].sql.includes("writing' OR true --"));
});
