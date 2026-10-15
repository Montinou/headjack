import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { appPool, migratedPg } from '../pglite.mjs';
let pg, db, legacy;
before(async () => { pg = await migratedPg(); db = createDb(appPool(pg)); legacy = await db.resolveOwner('user', 'legacy:v1'); });
after(async () => { await pg?.close(); });

test('operator binding preserves existing owner, data and legacy-token identity without copying skills', async () => {
  await db.withOwner(legacy, tx => tx.query("insert into skills(slug,name,description,kind) values ('old','old','existing private data','skill')"));
  await pg.query("select app.bind_clerk_legacy_owner('clerk:user_A')");
  assert.equal(await db.resolveOwner('user', 'clerk:user_A'), legacy);
  assert.equal(await db.resolveOwner('user', 'legacy:v1'), legacy);
  assert.equal((await db.withOwner(legacy, tx => tx.query('select count(*)::int n from skills'))).rows[0].n, 1);
  await pg.query("select app.bind_clerk_legacy_owner('clerk:user_A')");
  assert.equal((await pg.query('select count(*)::int n from app.owner_aliases')).rows[0].n, 1);
});

test('a second account cannot claim the same legacy data and gets an isolated owner', async () => {
  await assert.rejects(pg.query("select app.bind_clerk_legacy_owner('clerk:user_B')"), /already bound/);
  const b = await db.resolveOwner('user', 'clerk:user_B');
  assert.notEqual(b, legacy);
  assert.equal((await db.withOwner(b, tx => tx.query('select count(*)::int n from skills'))).rows[0].n, 0);
});

test('application role cannot read aliases or bind ownership, including from an authenticated transaction', async () => {
  for (const sql of ["select * from app.owner_aliases", "select app.bind_clerk_legacy_owner('clerk:user_C')"]) {
    await assert.rejects(db.withOwner(legacy, tx => tx.query(sql)), /permission denied/);
  }
});

test('binding refuses an existing canonical owner instead of silently merging accounts', async () => {
  const fresh = await migratedPg();
  try {
    const freshDb = createDb(appPool(fresh));
    const existing = await freshDb.resolveOwner('user', 'clerk:user_Existing');
    await assert.rejects(fresh.query("select app.bind_clerk_legacy_owner('clerk:user_Existing')"), /explicit merge required/);
    assert.equal(await freshDb.resolveOwner('user', 'clerk:user_Existing'), existing);
    assert.equal((await fresh.query('select count(*)::int n from app.owner_aliases')).rows[0].n, 0);
  } finally { await fresh.close(); }
});
