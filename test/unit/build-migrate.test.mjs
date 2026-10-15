import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as buildMigrate from '../../lib/build-migrate.mjs';
import { MIGRATION_LOCK_KEY, planBuild, runBuildMigrations } from '../../lib/build-migrate.mjs';
import { redact, settleWithin, vercelBuild } from '../../scripts/vercel-build.mjs';

const PASSWORD = 'p' + 'p'.repeat(39);
const OWNER_URL = 'postgres://neondb_owner:owner-secret' + '@ep-x.neon.tech/neondb';
// What the build needs besides the owner URL: the app role's URL, checked before any migration runs (0009 renames it).
const APP_ENV = { DATABASE_URL: 'postgres://pooled', HEADJACK_APP_DB_PASSWORD: PASSWORD };
// The old role name is built at runtime: no file outside the history may spell it.
const OLD_ROLE = [['skill', 'vault'].join(''), 'app'].join('_');

test('planBuild migrates in production and preview, never plans a password rotation, and builds only elsewhere', () => {
  for (const VERCEL_ENV of ['production', 'preview']) {
    const plan = planBuild({ VERCEL_ENV });
    assert.deepEqual(Object.keys(plan).sort(), ['migrate', 'reason']);
    assert.equal(plan.migrate, true);
    assert.doesNotMatch(plan.reason, /rotat|password/i);
  }
  for (const env of [{ VERCEL_ENV: 'development' }, {}]) {
    const plan = planBuild(env);
    assert.deepEqual(Object.keys(plan).sort(), ['migrate', 'reason']);
    assert.equal(plan.migrate, false);
    assert.equal(typeof plan.reason, 'string');
    assert.ok(plan.reason.length > 0);
  }
});

test('there is no branch guard: build-migrate exports no checkBranch', () => {
  // Native Neon preview branching with "Require Active Resource Before Deploy": a preview deploys only after Neon
  // injects its own branch, so the build trusts DATABASE_URL_UNPOOLED and NEON_PRODUCTION_BRANCH_ID is gone.
  assert.equal('checkBranch' in buildMigrate, false);
});

test('the advisory lock key is a fixed signed 64-bit constant', () => {
  assert.equal(typeof MIGRATION_LOCK_KEY, 'bigint');
  assert.equal(BigInt.asIntN(64, MIGRATION_LOCK_KEY), MIGRATION_LOCK_KEY);
  assert.equal(MIGRATION_LOCK_KEY, 1180429641688873904n);
});

// A fake owner session: records the steps runBuildMigrations takes and answers the queries it makes.
function fakeDb({ branchId = 'br-preview', migrations = 3, failMigrate = false } = {}) {
  const calls = [];
  const texts = [];
  let applied = 0;
  const query = async (text) => {
    texts.push(text);
    if (/pg_advisory_lock\(/.test(text)) { calls.push('lock'); assert.match(text, new RegExp(String(MIGRATION_LOCK_KEY))); return [{}]; }
    if (/pg_advisory_unlock\(/.test(text)) { calls.push('unlock'); assert.match(text, new RegExp(String(MIGRATION_LOCK_KEY))); return [{ pg_advisory_unlock: true }]; }
    if (/current_setting\('neon\.branch_id'/.test(text)) { calls.push('branch'); return [{ branch_id: branchId }]; }
    if (/to_regclass\('drizzle\.__drizzle_migrations'\)/.test(text)) return [{ present: applied > 0 }];
    if (/from drizzle\.__drizzle_migrations/.test(text)) return [{ n: applied }];
    if (/from pg_roles where rolname = 'headjack_app'/.test(text)) {
      return [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false }];
    }
    if (/pg_auth_members/.test(text)) return [];
    if (/alter role headjack_app/.test(text)) { calls.push('rotate'); return []; }
    throw new Error(`unexpected query: ${text}`);
  };
  const migrate = async () => {
    calls.push('migrate');
    if (failMigrate) throw new Error('migration 0006 failed');
    applied = migrations;
  };
  return { calls, texts, query, migrate };
}

const run = (db, overrides = {}) => runBuildMigrations({
  env: 'preview', ownerUrl: OWNER_URL,
  migrate: db.migrate, query: db.query, log: () => {}, ...overrides,
});

test('runBuildMigrations in preview: lock, branch read, migrate, unlock — no rotation', async () => {
  const db = fakeDb({ branchId: 'br-preview' });
  const out = await run(db);
  assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
  assert.deepEqual(out, { branchId: 'br-preview', applied: 3, total: 3 });
});

test('runBuildMigrations in production: lock, branch read, migrate, unlock — no rotation', async () => {
  const db = fakeDb({ branchId: 'br-prod' });
  const out = await run(db, { env: 'production' });
  assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
  assert.deepEqual(out, { branchId: 'br-prod', applied: 3, total: 3 });
});

test('runBuildMigrations migrates whatever branch it is on: no comparison, an unreadable branch id is only logged', async () => {
  for (const [env, branchId] of [['production', 'br-preview'], ['preview', 'br-prod'], ['preview', null], ['production', '']]) {
    const lines = [];
    const db = fakeDb({ branchId });
    const out = await run(db, { env, log: (line) => lines.push(line) });
    assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
    assert.equal(out.applied, 3);
    assert.match(lines.join('\n'), branchId ? new RegExp(branchId) : /branch unknown/);
  }
});

test('runBuildMigrations unlocks in finally when a migration fails, and keeps the migration error', async () => {
  const db = fakeDb({ failMigrate: true });
  await assert.rejects(run(db), /migration 0006 failed/);
  assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
});

test('runBuildMigrations keeps the original error when the unlock also fails', async () => {
  const db = fakeDb({ failMigrate: true });
  const query = async (text) => {
    if (/pg_advisory_unlock\(/.test(text)) throw new Error('connection lost');
    return db.query(text);
  };
  await assert.rejects(run(db, { query }), /migration 0006 failed/);
});

test('runBuildMigrations in preview never rotates and never requires the app password', async () => {
  // Option A (spec §11, revision 2026-10-02): a preview branch keeps the app password it inherited from production.
  for (const appPassword of [undefined, '', 'short-secret-value', PASSWORD]) {
    const db = fakeDb({ branchId: 'br-preview' });
    await run(db, { appPassword });
    assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
    assert.ok(!db.texts.some((t) => /headjack_app/.test(t)), 'no query touches headjack_app');
  }
});


test('runBuildMigrations logs the target, branch, environment and counts, never the password or the URL secret', async () => {
  const lines = [];
  const db = fakeDb({ branchId: 'br-preview' });
  await run(db, { log: (line) => lines.push(line) });
  const all = lines.join('\n');
  assert.match(all, /neondb_owner@ep-x\.neon\.tech\/neondb/);
  assert.match(all, /br-preview/);
  assert.match(all, /preview/);
  assert.match(all, /3/);
  assert.ok(!all.includes('owner-secret'));
  assert.ok(!all.includes(PASSWORD));
});

// vercel-build.mjs wiring: a fake connect() hands out a fake session, a fake nextBuild records that it ran.
function fakeBuild(dbOptions) {
  const db = fakeDb(dbOptions);
  const seen = { connected: [], closed: 0, nextBuild: 0 };
  const deps = {
    connect: (url) => { seen.connected.push(url); return { query: db.query, migrate: db.migrate, close: async () => { seen.closed += 1; } }; },
    nextBuild: async () => { seen.nextBuild += 1; },
    log: () => {},
  };
  return { db, seen, deps };
}

test('vercelBuild without VERCEL_ENV or in development only runs next build', async () => {
  for (const env of [{}, { VERCEL_ENV: 'development', DATABASE_URL_UNPOOLED: OWNER_URL }]) {
    const { seen, deps } = fakeBuild();
    await vercelBuild(env, deps);
    assert.deepEqual(seen, { connected: [], closed: 0, nextBuild: 1 });
  }
});

test('vercelBuild in preview migrates over DATABASE_URL_UNPOOLED without rotating, then runs next build', async () => {
  for (const appEnv of [APP_ENV, { DATABASE_URL_APP: 'postgres://headjack_app:app-secret@ep-x-pooler.neon.tech/neondb' }]) {
    const { db, seen, deps } = fakeBuild({ branchId: 'br-preview' });
    await vercelBuild({ VERCEL_ENV: 'preview', DATABASE_URL_UNPOOLED: OWNER_URL, ...appEnv }, deps);
    assert.deepEqual(seen.connected, [OWNER_URL]);
    assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
    assert.equal(seen.closed, 1);
    assert.equal(seen.nextBuild, 1);
  }
});

test('vercelBuild in production migrates without rotating', async () => {
  const { db, seen, deps } = fakeBuild({ branchId: 'br-prod' });
  await vercelBuild({ VERCEL_ENV: 'production', DATABASE_URL_UNPOOLED: OWNER_URL, ...APP_ENV }, deps);
  assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
  assert.equal(seen.nextBuild, 1);
});

test('vercelBuild fails naming DATABASE_URL_UNPOOLED when it is missing, without connecting or building', async () => {
  for (const VERCEL_ENV of ['production', 'preview']) {
    const { seen, deps } = fakeBuild();
    await assert.rejects(
      vercelBuild({ VERCEL_ENV, HEADJACK_APP_DB_PASSWORD: PASSWORD }, deps),
      /DATABASE_URL_UNPOOLED/,
    );
    assert.deepEqual(seen, { connected: [], closed: 0, nextBuild: 0 });
  }
});

test('vercelBuild in production and preview migrates and builds with the Neon-injected variables and the app password', async () => {
  for (const [VERCEL_ENV, branchId] of [['production', 'br-main'], ['preview', 'br-preview']]) {
    const { db, seen, deps } = fakeBuild({ branchId });
    const lines = [];
    deps.log = (line) => lines.push(line);
    await vercelBuild({ VERCEL_ENV, DATABASE_URL_UNPOOLED: OWNER_URL, ...APP_ENV }, deps);
    assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
    assert.deepEqual(seen, { connected: [OWNER_URL], closed: 1, nextBuild: 1 });
    assert.match(lines.join('\n'), new RegExp(branchId));
  }
});

// 0009 renames the app role in the build. An app-role URL the runtime would reject must fail the build first, with
// the owner session never opened, so no deployment is promoted that fails every request.
test('vercelBuild fails before connecting or migrating when DATABASE_URL_APP names the old role', async () => {
  for (const VERCEL_ENV of ['production', 'preview']) {
    const { db, seen, deps } = fakeBuild();
    const stale = `postgres://${OLD_ROLE}:stale-secret@ep-x-pooler.neon.tech/neondb`;
    await assert.rejects(
      vercelBuild({ VERCEL_ENV, DATABASE_URL_UNPOOLED: OWNER_URL, DATABASE_URL_APP: stale }, deps),
      (e) => /DATABASE_URL_APP must connect as headjack_app/.test(e.message) && !e.message.includes('stale-secret'),
    );
    assert.deepEqual(seen, { connected: [], closed: 0, nextBuild: 0 });
    assert.deepEqual(db.calls, []);
  }
});

test('vercelBuild fails before connecting or migrating when the app password is missing', async () => {
  for (const VERCEL_ENV of ['production', 'preview']) {
    const { db, seen, deps } = fakeBuild();
    await assert.rejects(
      vercelBuild({ VERCEL_ENV, DATABASE_URL_UNPOOLED: OWNER_URL, DATABASE_URL: 'postgres://pooled' }, deps),
      /HEADJACK_APP_DB_PASSWORD/,
    );
    assert.deepEqual(seen, { connected: [], closed: 0, nextBuild: 0 });
    assert.deepEqual(db.calls, []);
  }
});

test('vercelBuild without a migrate plan does not check the app-role URL', async () => {
  for (const env of [{ DATABASE_URL_APP: `postgres://${OLD_ROLE}:x@h/d` }, { VERCEL_ENV: 'development', DATABASE_URL_APP: `postgres://${OLD_ROLE}:x@h/d` }]) {
    const { seen, deps } = fakeBuild();
    await vercelBuild(env, deps);
    assert.deepEqual(seen, { connected: [], closed: 0, nextBuild: 1 });
  }
});

test('vercelBuild does not run next build when a migration fails', async () => {
  const { db, seen, deps } = fakeBuild({ branchId: 'br-preview', failMigrate: true });
  await assert.rejects(vercelBuild({ VERCEL_ENV: 'preview', DATABASE_URL_UNPOOLED: OWNER_URL, ...APP_ENV }, deps), /migration 0006 failed/);
  assert.deepEqual(db.calls, ['lock', 'branch', 'migrate', 'unlock']);
  assert.equal(seen.closed, 1);
  assert.equal(seen.nextBuild, 0);
});

test('the vercel-build script exits non-zero naming the missing variable, never printing values', async () => {
  const script = fileURLToPath(new URL('../../scripts/vercel-build.mjs', import.meta.url));
  const run = (env) => new Promise((resolve) => {
    execFile(process.execPath, [script], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, out: stdout + stderr });
    });
  });
  for (const VERCEL_ENV of ['production', 'preview']) {
    const missingUrl = await run({ VERCEL_ENV, DATABASE_URL: 'postgres://neondb_owner:pooled-secret' + '@ep-x-pooler.neon.tech/neondb', HEADJACK_APP_DB_PASSWORD: 'short-' + 'secret-value' });
    assert.equal(missingUrl.code, 1);
    assert.match(missingUrl.out, /DATABASE_URL_UNPOOLED is not set/);
    for (const secret of ['pooled-secret', 'short-secret-value']) assert.ok(!missingUrl.out.includes(secret), secret);
  }
});

test('the vercel-build script reports a refused owner connection and exits 1 promptly, never printing the password', async () => {
  // 127.0.0.1:1 refuses at once; nothing leaves the machine. A hang here (close() awaiting end() on a socket that
  // never opened) used to swallow the error: exit 13, "unsettled top-level await", no reason printed.
  const script = fileURLToPath(new URL('../../scripts/vercel-build.mjs', import.meta.url));
  const started = Date.now();
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [script], {
      timeout: 15_000,
      env: {
        PATH: process.env.PATH, VERCEL_ENV: 'preview', ...APP_ENV,
        DATABASE_URL_UNPOOLED: 'postgres://neondb_owner:refused-secret' + '@127.0.0.1:1/neondb',
      },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, signal: error?.signal, out: stdout + stderr }));
  });
  assert.equal(result.signal ?? null, null, 'the script hung until the test timeout');
  assert.equal(result.code, 1);
  assert.match(result.out, /vercel-build failed: \S/);
  assert.ok(Date.now() - started < 10_000);
  for (const secret of ['refused-secret', PASSWORD]) assert.ok(!result.out.includes(secret), secret);
});

test('vercelBuild keeps the migration error when closing the session also fails', async () => {
  const { seen, deps } = fakeBuild({ branchId: 'br-preview' });
  const lines = [];
  deps.log = (line) => lines.push(line);
  deps.connect = () => ({
    query: async () => { throw new Error('connect ECONNREFUSED'); },
    migrate: async () => {},
    close: async () => { seen.closed += 1; throw new Error('close failed'); },
  });
  await assert.rejects(vercelBuild({
    VERCEL_ENV: 'preview', DATABASE_URL_UNPOOLED: OWNER_URL, ...APP_ENV,
  }, deps), /ECONNREFUSED/);
  assert.equal(seen.closed, 1);
  assert.equal(seen.nextBuild, 0);
  assert.match(lines.join('\n'), /close failed/);
});

test('vercelBuild fails without building when only closing the session fails', async () => {
  const { seen, deps } = fakeBuild({ branchId: 'br-prod' });
  const session = deps.connect;
  deps.connect = (url) => ({ ...session(url), close: async () => { throw new Error('close failed'); } });
  await assert.rejects(vercelBuild({ VERCEL_ENV: 'production', DATABASE_URL_UNPOOLED: OWNER_URL, ...APP_ENV }, deps), /close failed/);
  assert.equal(seen.nextBuild, 0);
});

test('settleWithin rejects a promise that never settles, and passes through one that does', async () => {
  await assert.rejects(settleWithin(new Promise(() => {}), 20, 'closing hung'), /closing hung/);
  assert.equal(await settleWithin(Promise.resolve('ok'), 1_000, 'unused'), 'ok');
  await assert.rejects(settleWithin(Promise.reject(new Error('boom')), 1_000, 'unused'), /boom/);
});

test('redact removes connection strings, their password and the app password from an error message', () => {
  const env = {
    DATABASE_URL_UNPOOLED: OWNER_URL, DATABASE_URL: 'postgres://neondb_owner:pooled-secret' + '@ep-x-pooler.neon.tech/neondb',
    HEADJACK_APP_DB_PASSWORD: PASSWORD,
  };
  const out = redact(`connect ${OWNER_URL} failed; pooled ${env.DATABASE_URL}; auth owner-secret; password ${PASSWORD}`, env);
  for (const secret of ['owner-secret', 'pooled-secret', PASSWORD]) assert.ok(!out.includes(secret), secret);
  assert.match(out, /<DATABASE_URL_UNPOOLED>/);
  assert.match(out, /<HEADJACK_APP_DB_PASSWORD>/);
  assert.equal(redact('plain message', {}), 'plain message');
});
