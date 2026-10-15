import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MIGRATIONS, closePg, migrateThrough, newPg, rowsOf } from '../pglite.mjs';

// The old role name is built at runtime: this file replays the rename, so it is one of the few allowed to name it.
const OLD = ['skillvault', 'app'].join('_');
const NEW = 'headjack_app';

const roleNames = (pg) => rowsOf(pg)(`select rolname from pg_roles where rolname in ('${OLD}', '${NEW}') order by rolname`);
// Drizzle wraps the driver error, so the SQL message sits in `cause`.
const raises = (re) => (e) => re.test(e.cause?.message ?? e.message);

test(`after 0001…0009 the app role is ${NEW} and the old one is gone`, async () => {
  const pg = await newPg();
  await migrateThrough(pg, '0009_');
  assert.deepEqual(await roleNames(pg), [{ rolname: NEW }]);
  await closePg(pg);
});

test(`every policy targets ${NEW}`, async () => {
  const pg = await newPg();
  await migrateThrough(pg, '0009_');
  const rows = await rowsOf(pg)('select distinct unnest(roles)::text as role from pg_policies');
  assert.deepEqual(rows.map((r) => r.role), [NEW]);
  await closePg(pg);
});

test('re-running 0009 is a no-op', async () => {
  const pg = await newPg();
  await migrateThrough(pg, '0009_');
  await pg.exec(await readFile(path.join(MIGRATIONS, '0009_rename_app_role.sql'), 'utf8'));
  assert.deepEqual(await roleNames(pg), [{ rolname: NEW }]);
  await closePg(pg);
});

test('0009 raises when both roles exist', async () => {
  const pg = await newPg();
  await migrateThrough(pg, '0008_');
  await pg.exec(`create role ${NEW} nologin`);
  await assert.rejects(migrateThrough(pg, '0009_'), raises(new RegExp(`both ${OLD} and ${NEW} exist`)));
  assert.deepEqual(await roleNames(pg), [{ rolname: NEW }, { rolname: OLD }].sort((a, b) => (a.rolname < b.rolname ? -1 : 1)));
  await closePg(pg);
});

test('0009 raises when neither role exists', async () => {
  const pg = await newPg();
  await migrateThrough(pg, '0008_');
  // A plain drop would fail: tables, grants and policies depend on the role. Rename it away instead.
  await pg.exec(`alter role ${OLD} rename to gone_app`);
  await assert.rejects(migrateThrough(pg, '0009_'), raises(new RegExp(`neither ${OLD} nor ${NEW} exists`)));
  await closePg(pg);
});

// Same shape as foundation.test.mjs: Neon's owner owns the database, may create roles, and is not a superuser.
test('0009 run by a non-superuser CREATEROLE owner succeeds', async () => {
  const pg = await newPg();
  const q = rowsOf(pg);
  await pg.exec('create extension vector; create role mig nologin createrole bypassrls;');
  const [{ db }] = await q('select current_database() as db');
  await pg.exec(`alter database "${db}" owner to mig; set role mig;`);
  await migrateThrough(pg, '0009_');
  assert.deepEqual(await q('select current_user as u, rolsuper from pg_roles where rolname = current_user'), [{ u: 'mig', rolsuper: false }]);
  assert.deepEqual(await roleNames(pg), [{ rolname: NEW }]);
  await closePg(pg);
});

// Production order: the password was set on the old role (scripts/set-app-password.mjs) before 0009 runs. A rename
// keeps the role's OID, so the login flag and the stored password hash must come through unchanged.
test('0009 keeps LOGIN and the password hash of a role that already has a password', async () => {
  const pg = await newPg();
  const q = rowsOf(pg);
  await migrateThrough(pg, '0008_');
  await pg.exec(`alter role ${OLD} with login password 'a-long-enough-test-password-0123456789'`);
  const [before] = await q(`select rolcanlogin, rolpassword from pg_authid where rolname = '${OLD}'`);
  assert.equal(before.rolcanlogin, true);
  assert.ok(before.rolpassword, 'the old role has a stored password');
  await migrateThrough(pg, '0009_');
  assert.deepEqual(await q(`select rolcanlogin, rolpassword from pg_authid where rolname = '${NEW}'`), [before]);
  await closePg(pg);
});
