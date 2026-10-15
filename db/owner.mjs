// Owner-role connection for the controller's migration scripts (never used by the app). The URL must be given
// explicitly in DATABASE_URL_OWNER, read at a prompt in a subshell (see docs/operations.md, step 4), so a script never picks
// production up from .env.local by accident and the URL stays out of the shell history.
import { Pool, neonConfig } from '@neondatabase/serverless';

if (!neonConfig.webSocketConstructor && globalThis.WebSocket) neonConfig.webSocketConstructor = globalThis.WebSocket;

export function ownerUrl(env) {
  if (!env.DATABASE_URL_OWNER) throw new Error('set DATABASE_URL_OWNER (the owner-role URL of the target branch) for this command');
  return env.DATABASE_URL_OWNER;
}

// Runs fn(query) in one transaction on the owner role; query(text, params) → rows.
export async function withOwnerRole(env, fn, { readOnly = false } = {}) {
  const pool = new Pool({ connectionString: ownerUrl(env), max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query(readOnly ? 'begin read only' : 'begin');
    const out = await fn((text, params) => client.query(text, params).then((r) => r.rows));
    await client.query('commit');
    return out;
  } catch (e) {
    await client?.query('rollback').catch(() => {});
    throw e;
  } finally {
    client?.release();
    await pool.end();
  }
}

// User, host and database of a connection string, for logs (never the password). new URL()'s TypeError carries the
// whole input, so a malformed URL gets a fixed placeholder instead of that error.
export function describeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return '<unparseable DATABASE_URL_OWNER>'; }
  return `${u.username}@${u.host}${u.pathname}`;
}
