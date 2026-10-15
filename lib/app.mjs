import { Pool, neonConfig } from '@neondatabase/serverless';
import { appDatabaseUrl, createDb } from './db.mjs';
import { repoForOwner } from './repo.mjs';
import { createIdentity, LEGACY_OWNER_REF } from './identity.mjs';
import { embedTexts } from './embed.mjs';
import { enrichSkill, gatewayGenerate } from './enrich.mjs';
import { createHandlers } from './handlers.mjs';
import { clerkIdentityResolver } from './clerk-identity.mjs';
import { clerkConfigured } from './clerk-config.mjs';

if (!neonConfig.webSocketConstructor && globalThis.WebSocket) neonConfig.webSocketConstructor = globalThis.WebSocket;

// Opens the app-role pool (never the owner URL) and hands back what createDb exposes; the pool stays in here.
export function openAppDb(env = process.env) {
  const pool = new Pool({ connectionString: appDatabaseUrl(env) });
  // An idle client dropped by the server emits 'error' on the pool; unhandled, it would crash the function.
  pool.on('error', (e) => console.error('pg pool error', e.message));
  return { ...createDb(pool), end: () => pool.end() };
}

// The search flags. flags.ts is imported inside the function, never at module load, so plain-Node consumers of this
// module (scripts, tests) never load flags/next.
async function resolveFlags(req, { ownerId, sessionId }) {
  const { evaluateSearchFlags } = await import('../flags.ts');
  return evaluateSearchFlags({ ownerId, sessionId });
}

// True when the request pins its flag values by hand (an evaluation run), so its searches log no exposure.
export function isFlagOverridden(req) {
  return (req.headers.get('cookie') ?? '').includes('vercel-flag-overrides=');
}

let handlers;
export function app() {
  if (handlers) return handlers;
  const db = openAppDb(process.env);
  let clerkClient;
  const clerk = clerkIdentityResolver({
    env: process.env,
    enabled: async () => clerkConfigured(process.env) && (await import('../flags.ts')).clerkAuth(),
    getClient: async () => {
      clerkClient ??= (await import('@clerk/backend')).createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY,
        publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      });
      return clerkClient;
    },
  });
  const identity = createIdentity({ resolvers: [clerk], resolveOwner: db.resolveOwner });
  handlers = createHandlers({
    identify: identity.identify,
    repoFor: (ownerId) => repoForOwner(db.withOwner, ownerId),
    listOwnerIds: db.listOwnerIds,
    embed: embedTexts,
    enrich: (skill) => enrichSkill(skill, { generate: gatewayGenerate }),
    env: process.env,
    resolveFlags,
    overridden: isFlagOverridden,
  });
  return handlers;
}

// Maintenance scripts act as exactly one owner through the app role, like a request: HEADJACK_OWNER_ID, or the
// initial (legacy) owner. The owner role is for migrations only (it has BYPASSRLS on Neon, so RLS would not apply).
export async function openOwnerRepo(env = process.env, open = openAppDb) {
  const db = open(env);
  try {
    const ownerId = env.HEADJACK_OWNER_ID ? Number(env.HEADJACK_OWNER_ID) : await db.resolveOwner('user', LEGACY_OWNER_REF);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error(`HEADJACK_OWNER_ID must be a positive integer, got ${env.HEADJACK_OWNER_ID}`);
    return { ownerId, repo: repoForOwner(db.withOwner, ownerId), end: db.end };
  } catch (e) {
    await db.end();
    throw e;
  }
}
