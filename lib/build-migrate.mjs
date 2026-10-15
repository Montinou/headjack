// Build-time migrations (spec §11): which Vercel builds migrate, and the locked run itself. There is no branch guard:
// with native Neon preview branching and "Require Active Resource Before Deploy", a preview deploys only after Neon
// injects its own branch, so the build migrates whatever owner URL it is handed and logs its neon.branch_id.
// Everything that touches a database is injected, so this module loads without one; scripts/vercel-build.mjs wires it.
import { describeUrl } from '../db/owner.mjs';

// Advisory lock key shared by every build that migrates: a fixed key (a signed 64-bit integer), so concurrent builds
// against one branch wait for each other. Its value never changes.
export const MIGRATION_LOCK_KEY = 1180429641688873904n;

// VERCEL_ENV production or preview → migrate; anything else → build only. → { migrate, reason }.
// The build never touches headjack_app's password (spec §11, revision 2026-10-02, option A): a preview branch keeps
// the one it inherited from production; scripts/set-app-password.mjs stays a manual tool.
export function planBuild(env) {
  const target = env.VERCEL_ENV;
  if (target === 'production' || target === 'preview') return { migrate: true, reason: `${target}: run migrations` };
  return { migrate: false, reason: `VERCEL_ENV=${target || 'unset'}: no migrations, build only` };
}

// Migrations recorded by drizzle's migrator (its default table), 0 before the first run.
async function appliedMigrations(query) {
  const [{ present }] = await query("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
  if (!present) return 0;
  const [{ n }] = await query('select count(*)::int as n from drizzle.__drizzle_migrations');
  return n;
}

// On one owner session: lock → read the branch id (logged for traceability, never compared) → migrate → unlock.
// query(text) → rows and migrate() must share that session, so the lock covers the migrations.
export async function runBuildMigrations({ env, ownerUrl, migrate, query, log = console.log }) {
  await query(`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`);
  let failed = true;
  try {
    const [{ branch_id: branchId }] = await query("select current_setting('neon.branch_id', true) as branch_id");
    log(`${env}: migrating ${describeUrl(ownerUrl)} on Neon branch ${branchId || 'unknown'}`);
    const before = await appliedMigrations(query);
    await migrate();
    const total = await appliedMigrations(query);
    log(`${env}: applied ${total - before} migration(s), ${total} in total, on branch ${branchId || 'unknown'}`);
    failed = false;
    return { branchId, applied: total - before, total };
  } finally {
    // An unlock failure (e.g. a dropped connection, which releases the lock anyway) never hides the run's own error.
    await query(`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`).catch((e) => { if (!failed) throw e; });
  }
}
