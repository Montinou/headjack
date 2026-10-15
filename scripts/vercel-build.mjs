// Vercel runs this instead of `next build` (package.json "vercel-build"). Spec §11:
//   1. production or preview: drizzle migrations over DATABASE_URL_UNPOOLED (the integration's direct owner URL),
//      inside an advisory lock (lib/build-migrate.mjs). No branch guard: with native Neon preview branching and
//      "Require Active Resource Before Deploy", a preview's URL is its own Neon branch, production's is main;
//   2. next build.
// headjack_app's password is never touched here (option A, spec §11 revision 2026-10-02): preview branches keep the
// one inherited from production.
// Without VERCEL_ENV (a local `npm run vercel-build`) or in development it only builds. Any failure exits non-zero.
// Logs carry only the target's user@host/db, the branch id, the environment and migration counts.
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { ownerUrl } from '../db/owner.mjs';
import { planBuild, runBuildMigrations } from '../lib/build-migrate.mjs';
import { appDatabaseUrl } from '../lib/db.mjs';

const MIGRATIONS = fileURLToPath(new URL('../drizzle/', import.meta.url));
const SECRETS = ['DATABASE_URL_UNPOOLED', 'DATABASE_URL', 'HEADJACK_APP_DB_PASSWORD'];
const CLOSE_TIMEOUT_MS = 5_000;

// One owner session (a Client, not a Pool: drizzle's migrator and the advisory lock must share the connection),
// connected on first use so input checks run before any network. close() ends only a session that connected
// (end() on one whose connect() failed never settles) and is bounded, so a dropped socket cannot hang the build.
export function connectOwner(url) {
  const client = new Client(url);
  let ready;
  let connected = false;
  const open = () => (ready ??= client.connect().then(() => { connected = true; }));
  return {
    query: async (text, params) => { await open(); return (await client.query(text, params)).rows; },
    migrate: async () => { await open(); await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS }); },
    close: async () => {
      if (connected) await settleWithin(client.end(), CLOSE_TIMEOUT_MS, `closing the owner connection took over ${CLOSE_TIMEOUT_MS} ms`);
    },
  };
}

// Settles like `promise`, or rejects with `message` after `ms`; the timer is cleared once either settles.
export function settleWithin(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function runNextBuild() {
  const bin = createRequire(import.meta.url).resolve('next/dist/bin/next');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'build'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`next build failed (${signal ?? `exit ${code}`})`))));
  });
}

export async function vercelBuild(env, { connect = connectOwner, nextBuild = runNextBuild, log = console.log } = {}) {
  const plan = planBuild(env);
  log(`vercel-build: ${plan.reason}`);
  if (plan.migrate) {
    if (!env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED is not set: the Neon integration provides it in production and preview');
    // Fail before 0009 renames the app role, not after: the app builds its own URL the same way at runtime, so an invalid
    // one here (a stale DATABASE_URL_APP user, a missing password) would otherwise ship a deployment that fails every
    // request. Opens no connection; the messages name variables only, never values.
    appDatabaseUrl(env);
    // db/owner.mjs reads the owner URL from DATABASE_URL_OWNER; in the build that is the integration's direct URL.
    const url = ownerUrl({ DATABASE_URL_OWNER: env.DATABASE_URL_UNPOOLED });
    const session = connect(url);
    let migrated = false;
    try {
      await runBuildMigrations({
        env: env.VERCEL_ENV, ownerUrl: url, migrate: session.migrate, query: session.query, log,
      });
      migrated = true;
    } finally {
      // A close failure fails a successful run, but never replaces the error a failed run is propagating.
      await session.close().catch((e) => {
        if (migrated) throw e;
        log(`vercel-build: closing the owner connection also failed: ${redact(e?.message || String(e), env)}`);
      });
    }
  }
  await nextBuild();
}

// Driver errors can quote their input: replace connection strings, their passwords and the app password by name.
export function redact(message, env) {
  let out = message;
  for (const name of SECRETS) {
    const value = env[name];
    if (!value) continue;
    out = out.replaceAll(value, `<${name}>`);
    try {
      const { password } = new URL(value);
      if (password) out = out.replaceAll(password, '<password>').replaceAll(decodeURIComponent(password), '<password>');
    } catch { /* not a URL */ }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    await vercelBuild(process.env);
  } catch (e) {
    // A refused WebSocket connection arrives as an ErrorEvent with an empty message.
    const reason = e?.message || (e?.type ? `could not connect to the owner database (${e.type})` : String(e));
    console.error(`vercel-build failed: ${redact(reason, process.env)}`);
    process.exit(1);
  }
}
