// The only way app code reaches the database. Every query runs inside withOwner(ownerId, fn): one transaction whose
// first statement pins app.owner_id, which the RLS policies read. The pool itself never leaves this module.
export const APP_ROLE = 'headjack_app';

// Pool-shaped dependency: { connect() → { query(text, params) → { rows }, release(err?) }, query(text, params) }.
export function createDb(pool) {
  async function withOwner(ownerId, fn) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new TypeError(`withOwner needs a positive integer owner id, got ${ownerId}`);
    const client = await pool.connect();
    let open = true;
    let broken;
    // fn gets query() only: no release, no escaping the transaction, and no use after it ends.
    const tx = {
      query(text, params) {
        if (!open) return Promise.reject(new Error('withOwner: transaction already finished'));
        return client.query(text, params);
      },
    };
    try {
      await client.query('begin');
      await client.query("select set_config('app.owner_id', $1, true)", [String(ownerId)]);
      let out;
      // Close the handle as soon as fn settles, so nothing slips in while commit or rollback runs.
      try { out = await fn(tx); } finally { open = false; }
      await client.query('commit');
      return out;
    } catch (e) {
      // A failed rollback means the connection is unusable: keep the original error, discard the client.
      try { await client.query('rollback'); } catch (rollbackError) { broken = rollbackError; }
      throw e;
    } finally {
      open = false;
      client.release(broken);
    }
  }

  // SECURITY DEFINER functions (drizzle/0004_rls.sql): they return ids only, never rows or a client.
  async function resolveOwner(kind, refId) {
    const { rows } = await pool.query('select app.resolve_owner($1, $2) as id', [kind, refId]);
    return Number(rows[0].id);
  }

  async function listOwnerIds() {
    const { rows } = await pool.query('select id from app.list_owner_ids() as id');
    return rows.map((r) => Number(r.id));
  }

  return { withOwner, resolveOwner, listOwnerIds };
}

// Connection string for the app role. DATABASE_URL_APP wins; otherwise DATABASE_URL (the owner URL the Neon
// integration injects, per preview branch) with its user and password swapped for headjack_app. Never falls back
// to the owner credentials.
export function appDatabaseUrl(env) {
  if (env.DATABASE_URL_APP) {
    const u = parseUrl(env.DATABASE_URL_APP, 'DATABASE_URL_APP');
    if (decodeURIComponent(u.username) !== APP_ROLE) throw new Error(`DATABASE_URL_APP must connect as ${APP_ROLE}`);
    return env.DATABASE_URL_APP;
  }
  if (!env.DATABASE_URL || !env.HEADJACK_APP_DB_PASSWORD) {
    throw new Error('set DATABASE_URL_APP, or DATABASE_URL plus HEADJACK_APP_DB_PASSWORD, for the app database role');
  }
  const u = parseUrl(env.DATABASE_URL, 'DATABASE_URL');
  u.username = APP_ROLE;
  u.password = env.HEADJACK_APP_DB_PASSWORD;
  return u.toString();
}

// Node's ERR_INVALID_URL carries the raw string (password included) in err.input, which util.inspect prints.
// Rethrow with the variable name only, and no cause.
function parseUrl(value, name) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
}
