import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATION_LOCK_KEY, runBuildMigrations } from '../../lib/build-migrate.mjs';
import { MIGRATIONS, closePg, newPg, rowsOf } from '../pglite.mjs';

const OWNER_URL = 'postgres://neondb_owner:owner-secret' + '@ep-x.neon.tech/neondb';
const journal = JSON.parse(await readFile(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));

// pg_locks splits a bigint advisory key into classid (high 32 bits) and objid (low 32 bits), with objsubid = 1.
const LOCK_HELD = `select count(*)::int as n from pg_locks where locktype = 'advisory' and objsubid = 1
  and ((classid::bigint << 32) | objid::bigint) = ${MIGRATION_LOCK_KEY}`;

// A PGlite "branch": one session, with neon.branch_id set the way Neon sets it.
async function branch(branchId) {
  const pg = await newPg();
  await pg.exec(`set neon.branch_id = '${branchId}'`);
  return pg;
}

// Runs the migrations through drizzle's PGlite migrator, recording whether the advisory lock was held meanwhile.
function migrator(pg, seen) {
  return async () => {
    const [{ n }] = await rowsOf(pg)(LOCK_HELD);
    seen.push(n);
    await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS });
  };
}

test('preview: migrations apply through the lock, the app role is left as migrated, and a second run is a no-op', async () => {
  const pg = await branch('br-preview');
  try {
    const q = rowsOf(pg);
    const seen = [];
    // No password rotation in the build (option A): the preview branch keeps the one it inherited from production.
    const args = { env: 'preview', ownerUrl: OWNER_URL, migrate: migrator(pg, seen), query: q, log: () => {} };
    const first = await runBuildMigrations(args);
    assert.deepEqual(first, { branchId: 'br-preview', applied: journal.entries.length, total: journal.entries.length });
    assert.deepEqual(await q("select rolcanlogin from pg_roles where rolname = 'headjack_app'"), [{ rolcanlogin: false }]);
    assert.deepEqual(await q(LOCK_HELD), [{ n: 0 }], 'unlocked after the run');

    const second = await runBuildMigrations(args);
    assert.deepEqual(second, { branchId: 'br-preview', applied: 0, total: journal.entries.length });
    assert.deepEqual(await q('select count(*)::int as n from drizzle.__drizzle_migrations'), [{ n: journal.entries.length }]);
    assert.deepEqual(seen, [1, 1], 'the lock was held while migrating');
    assert.deepEqual(await q(LOCK_HELD), [{ n: 0 }]);
  } finally {
    await closePg(pg);
  }
});

test('production migrates the branch it is given and leaves the app role alone', async () => {
  const pg = await branch('br-main');
  try {
    const q = rowsOf(pg);
    const out = await runBuildMigrations({ env: 'production', ownerUrl: OWNER_URL, migrate: migrator(pg, []), query: q, log: () => {} });
    assert.deepEqual(out, { branchId: 'br-main', applied: journal.entries.length, total: journal.entries.length });
    assert.deepEqual(await q("select rolcanlogin from pg_roles where rolname = 'headjack_app'"), [{ rolcanlogin: false }]);
  } finally {
    await closePg(pg);
  }
});

test('no branch guard: each environment migrates the branch it is on and logs its neon.branch_id', async () => {
  for (const [env, branchId] of [['production', 'br-preview'], ['preview', 'br-main']]) {
    const pg = await branch(branchId);
    try {
      const q = rowsOf(pg);
      const lines = [];
      const out = await runBuildMigrations({ env, ownerUrl: OWNER_URL, migrate: migrator(pg, []), query: q, log: (line) => lines.push(line) });
      assert.equal(out.applied, journal.entries.length);
      assert.match(lines.join('\n'), new RegExp(`${env}: .*${branchId}`));
      assert.deepEqual(await q(LOCK_HELD), [{ n: 0 }]);
    } finally {
      await closePg(pg);
    }
  }
});
