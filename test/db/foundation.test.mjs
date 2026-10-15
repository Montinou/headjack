import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MIGRATIONS, closePg, migrateThrough, newPg, rowsOf } from '../pglite.mjs';

test('0001 creates the app role without login, superuser, BYPASSRLS or inheritance', async () => {
  const pg = await newPg();
  await migrateThrough(pg, '0001_');
  assert.deepEqual(
    await rowsOf(pg)("select rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb from pg_roles where rolname = 'skillvault_app'"),
    [{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false }],
  );
  await closePg(pg);
});

test('app.current_owner_id() is NULL when unset or emptied, and the id when set', async () => {
  const pg = await newPg();
  await migrateThrough(pg, '0001_');
  const q = rowsOf(pg);
  assert.deepEqual(await q('select app.current_owner_id() as id'), [{ id: null }]);
  await pg.exec('begin');
  await q("select set_config('app.owner_id', '42', true)");
  assert.deepEqual(await q('select app.current_owner_id() as id'), [{ id: 42 }]);
  await pg.exec('commit');
  assert.deepEqual(await q("select current_setting('app.owner_id', true) as raw, app.current_owner_id() as id"), [{ raw: '', id: null }]);
  await closePg(pg);
});

test('0001 refuses to run as a role that could not own the schema or bypass RLS', async () => {
  const pg = await newPg();
  const file = (await readdir(MIGRATIONS)).find((f) => f.startsWith('0001_'));
  const guard = (await readFile(path.join(MIGRATIONS, file), 'utf8')).split('--> statement-breakpoint')[0];
  await pg.exec('create role plain_role nologin; set role plain_role');
  await assert.rejects(pg.exec(guard), /migrations must run as the owner role/);
  await closePg(pg);
});

// The production path: Neon's owner role is not a superuser but has BYPASSRLS.
test('0001 lets a non-superuser role with BYPASSRLS through the guard', async () => {
  const pg = await newPg();
  const file = (await readdir(MIGRATIONS)).find((f) => f.startsWith('0001_'));
  const guard = (await readFile(path.join(MIGRATIONS, file), 'utf8')).split('--> statement-breakpoint')[0];
  await pg.exec('create role mig nologin bypassrls; set role mig;');
  assert.deepEqual(await rowsOf(pg)('select current_user as u, rolsuper from pg_roles where rolname = current_user'), [{ u: 'mig', rolsuper: false }]);
  await pg.exec(guard);
  await closePg(pg);
});

// A pre-existing skillvault_app is left as it is: a non-superuser owner (Neon's) may not name NOSUPERUSER in ALTER ROLE.
test('0001 run by a non-superuser BYPASSRLS owner succeeds on a pre-existing app role and leaves it unchanged', async () => {
  const pg = await newPg();
  const q = rowsOf(pg);
  const role = "select rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb from pg_roles where rolname = 'skillvault_app'";
  // vector is installed beforehand, as on every existing database (0000 only CREATEs IF NOT EXISTS).
  await pg.exec('create extension vector; create role skillvault_app login; create role mig nologin bypassrls;');
  const [{ db }] = await q('select current_database() as db');
  await pg.exec(`alter database "${db}" owner to mig; set role mig;`); // like neondb_owner: owns the database, no superuser
  const before = await q(role);
  await migrateThrough(pg, '0001_');
  assert.deepEqual(await q('select current_user as u, rolsuper from pg_roles where rolname = current_user'), [{ u: 'mig', rolsuper: false }]);
  assert.deepEqual(await q(role), before);
  assert.deepEqual(await q('select app.current_owner_id() as id'), [{ id: null }]);
  await closePg(pg);
});
