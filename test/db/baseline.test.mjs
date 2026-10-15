import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptBaseline, baselineEntry, markBaseline } from '../../db/baseline.mjs';
import { dumpSchema } from '../../db/catalog.mjs';
import { fingerprint } from '../../db/fingerprint.mjs';
import { MIGRATIONS, closePg, migrateThrough, newPg, rowsOf, v1Database } from '../pglite.mjs';

test('markBaseline records 0000 the way drizzle does, so migrate() skips it on a v1 database', async () => {
  const pg = await v1Database();
  const before = await fingerprint(rowsOf(pg));
  assert.equal(await markBaseline(rowsOf(pg), MIGRATIONS), 'marked');
  const { hash, when } = await baselineEntry(MIGRATIONS);
  assert.deepEqual(await rowsOf(pg)('select hash, created_at::bigint as created_at from drizzle.__drizzle_migrations'), [{ hash, created_at: when }]);
  await migrateThrough(pg, '0000_'); // would fail with "relation already exists" if 0000 ran again
  assert.deepEqual(await fingerprint(rowsOf(pg)), before);
});

test('markBaseline is idempotent and refuses what it does not recognize', async () => {
  const pg = await v1Database();
  assert.equal(await markBaseline(rowsOf(pg), MIGRATIONS), 'marked');
  assert.equal(await markBaseline(rowsOf(pg), MIGRATIONS), 'already-marked');

  const other = await v1Database();
  await other.exec(`create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
    insert into drizzle.__drizzle_migrations (hash, created_at) values ('x', 1);`);
  await assert.rejects(markBaseline(rowsOf(other), MIGRATIONS), /refusing to guess/);

  await assert.rejects(markBaseline(rowsOf(await newPg()), MIGRATIONS), /no v1 schema/);
});

test('fingerprint counts rows and digests hashes and tarball bytes of a v1 database', async () => {
  const f = await fingerprint(rowsOf(await v1Database()));
  assert.deepEqual(
    { skills: f.skills, versions: f.versions, chunks: f.chunks, sources: f.sources, upstream: f.upstream, tarballs: f.tarballs },
    { skills: 3, versions: 4, chunks: 2, sources: 2, upstream: 2, tarballs: 2 },
  );
  for (const k of ['versions_digest', 'skills_digest', 'chunks_digest']) assert.match(f[k], /^[0-9a-f]{32}$/);
  const changed = await v1Database();
  await changed.exec("update versions set tarball = '\\x00'::bytea where id = 1");
  assert.notEqual((await fingerprint(rowsOf(changed))).versions_digest, f.versions_digest, 'one changed byte changes the digest');
});

test('adoptBaseline marks only after parity; a schema mismatch throws a labelled diff and marks nothing', async () => {
  const expected = await newPg();
  await migrateThrough(expected, '0000_');
  const want = await dumpSchema(rowsOf(expected));
  const migrationsTable = async (pg) => (await rowsOf(pg)("select to_regclass('drizzle.__drizzle_migrations') as t"))[0].t;

  const same = await v1Database();
  assert.deepEqual(await adoptBaseline(rowsOf(same), MIGRATIONS, want, { check: true }), { lines: want.length, result: 'checked' });
  assert.equal(await migrationsTable(same), null, '--check marks nothing');
  assert.deepEqual(await adoptBaseline(rowsOf(same), MIGRATIONS, want), { lines: want.length, result: 'marked' });

  const drifted = await v1Database();
  await drifted.exec('alter table skills add column stray int; alter table upstream drop column update_available;');
  await assert.rejects(adoptBaseline(rowsOf(drifted), MIGRATIONS, want), (e) => {
    assert.match(e.message, /schema differs from drizzle\/0000_baseline: 1 missing, 1 extra/);
    assert.match(e.message, /^- \(baseline only\) column upstream\.update_available /m);
    assert.match(e.message, /^\+ \(database only\) column skills\.stray /m);
    return true;
  });
  assert.equal(await migrationsTable(drifted), null, 'a mismatch creates no drizzle.__drizzle_migrations');
  await closePg(expected, same, drifted);
});
