import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { markBaseline } from '../../db/baseline.mjs';
import { fingerprint } from '../../db/fingerprint.mjs';
import { MIGRATIONS, closePg, migrateThrough, newPg, rowsOf, v1Database } from '../pglite.mjs';

test('on a v1 database, marking the baseline and migrating keeps every row, hash and tarball byte', async () => {
  const pg = await v1Database();
  const before = await fingerprint(rowsOf(pg));
  assert.equal(before.tarballs, 2);

  await pg.exec('begin');
  assert.equal(await markBaseline(rowsOf(pg), MIGRATIONS), 'marked');
  await pg.exec('commit');
  await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS }); // must skip 0000 (its CREATE TABLEs would fail)

  assert.deepEqual(await fingerprint(rowsOf(pg)), before);
  const q = rowsOf(pg);
  assert.deepEqual(await q('select kind, ref_id from owners'), [{ kind: 'user', ref_id: 'legacy:v1' }]);
  for (const t of ['skills', 'versions', 'sources', 'chunks', 'upstream']) {
    const [r] = await q(`select count(*)::int as n, count(distinct owner_id)::int as owners from ${t}`);
    assert.equal(r.owners, 1, `${t} is entirely owned by the legacy owner`);
  }
  assert.deepEqual(await q('select count(*)::int as n from blobs'), [{ n: 1 }], 'identical tarballs are stored once');
  assert.deepEqual(
    await q('select count(*)::int as n from app.blob_holders h join owners o on o.id = h.owner_id join blobs b on b.sha256 = h.sha256 where o.ref_id = $1', ['legacy:v1']),
    [{ n: 1 }],
    'the legacy owner holds the migrated blob, so its versions may keep pointing at it',
  );
  const cols = await q("select column_name from information_schema.columns where table_name = 'versions' and column_name = 'tarball'");
  assert.deepEqual(cols, [], 'versions.tarball is gone');
  await closePg(pg);
});

test('a failing tarball check rolls the whole migration back and leaves the v1 schema untouched', async () => {
  const pg = await v1Database();
  await pg.exec('begin');
  await markBaseline(rowsOf(pg), MIGRATIONS);
  await pg.exec('commit');
  // A trigger that corrupts the copy makes the byte-equality check in 0002 fail.
  await pg.exec(`create function corrupt() returns trigger language plpgsql as $$ begin new.data := '\\x00'::bytea; new.sha256 := encode(sha256('\\x00'::bytea), 'hex'); new.size := 1; return new; end $$;`);
  const before = await fingerprint(rowsOf(pg));
  await assert.rejects(
    (async () => {
      // blobs does not exist yet: an event trigger attaches the corrupting trigger as soon as 0002 creates the table.
      await pg.exec(`create function hook() returns event_trigger language plpgsql as $$
        begin if exists (select 1 from pg_tables where tablename = 'blobs') and not exists (select 1 from pg_trigger where tgname = 'corrupt_blobs') then
          create trigger corrupt_blobs before insert on public.blobs for each row execute function corrupt(); end if; end $$;
        create event trigger hook_blobs on ddl_command_end execute function hook();`);
      await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS });
    })(),
    // The raised error itself, not the query text drizzle echoes in its message: the corrupted copy trips only the byte check.
    (e) => /^tarball move check failed: 2 tarballs, 2 with blob, 1 distinct hashes, 1 blobs, 2 mismatched$/.test(e.cause?.message ?? e.message),
  );
  await pg.exec('drop event trigger hook_blobs');
  assert.deepEqual(await fingerprint(rowsOf(pg)), before);
  const q = rowsOf(pg);
  assert.deepEqual(await q("select to_regclass('public.owners') as t"), [{ t: null }]);
  assert.deepEqual(await q('select count(*)::int as n from drizzle.__drizzle_migrations'), [{ n: 1 }], 'only the 0000 baseline row');
  assert.deepEqual(
    await q("select column_name from information_schema.columns where table_name = 'versions' and column_name = 'tarball'"),
    [{ column_name: 'tarball' }],
    'versions.tarball is still there',
  );
  assert.deepEqual(await q("select to_regnamespace('app') as n"), [{ n: null }], '0001 rolled back too');
  await closePg(pg);
});

test('0003 refuses to drop versions.tarball while a tarball has no blob', async () => {
  const pg = await v1Database();
  await pg.exec('begin');
  await markBaseline(rowsOf(pg), MIGRATIONS);
  await pg.exec('commit');
  await migrateThrough(pg, '0002_');
  const q = rowsOf(pg);
  await q('update versions set blob_sha256 = null where id = 2'); // a tarball 0002 did not move
  await assert.rejects(
    migrateThrough(pg),
    (e) => /^tarball drop guard: 1 rows still unmigrated$/.test(e.cause?.message ?? e.message),
  );
  assert.deepEqual(
    await q("select column_name from information_schema.columns where table_name = 'versions' and column_name = 'tarball'"),
    [{ column_name: 'tarball' }],
    'versions.tarball is still there',
  );
  await closePg(pg);
});

// A hand-made skillvault_app that can bypass RLS would silently void every policy: 0004 refuses to run, and since
// drizzle applies every pending migration in one transaction, nothing from 0000-0004 is left behind.
test('0004 refuses a skillvault_app that is superuser, BYPASSRLS or a member of any role, and the whole migration rolls back', async () => {
  const setups = {
    bypassrls: 'create role skillvault_app nologin bypassrls',
    superuser: 'create role skillvault_app nologin superuser',
    // A Console-made role granted into e.g. neon_superuser inherits BYPASSRLS without carrying the attribute itself.
    membership: 'create role parent nologin; create role skillvault_app nologin in role parent',
  };
  for (const [attr, sql] of Object.entries(setups)) {
    const fresh = await newPg();
    try {
      await fresh.exec(sql);
      await assert.rejects(
        migrateThrough(fresh),
        (e) => /^skillvault_app must not be superuser, bypassrls or a member of any role$/.test(e.cause?.message ?? e.message),
        attr,
      );
      const q = rowsOf(fresh);
      assert.deepEqual(await q("select to_regclass('public.skills') as s, to_regclass('public.owners') as o, to_regnamespace('app') as a"), [{ s: null, o: null, a: null }], attr);
      assert.deepEqual(await q("select count(*)::int as n from drizzle.__drizzle_migrations"), [{ n: 0 }], attr);
    } finally {
      await closePg(fresh);
    }
  }
});
