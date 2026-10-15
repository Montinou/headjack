// Guarded acceptance database steps on the feature branch's Neon preview branch (spec D6 and §6 step 5).
//
//   node scripts/acceptance-db.mjs reset|check|quota --branch preview/feat/mcp-cli-login --project <neon project id>
//        --production-branch <production branch id> --neon-key-file <file holding a Neon API key>
//        [--owner-ref clerk:user_… --other-ref clerk:user_…]
//
// reset  deletes every owner, all owner data and the tarball blobs in one transaction (TRUNCATE public.owners,
//        public.blobs … CASCADE, every table locked before it is counted) and prints the row counts it removed.
// check  asserts there are no owners other than the given refs and no app.owner_aliases rows.
// quota  opens 61 concurrent app-role sessions with owner A's context, calls app.consume_mcp_search_budget() once in
//        each (exactly 60 must be allowed), then once as owner B (allowed); A never holds more than two budget rows.
//        The app-role password is read from stdin (a hidden prompt on a terminal).
//
// The preview branch is a copy of production, so the guards are the point, and every one runs before any statement
// that changes data: the branch is found by exact name through the Neon API and refused when its id is the given
// production id or Neon marks it default or primary; the owner connection string comes only from the Neon API for that
// branch id, and the app-role session only takes its endpoint host from it; every session asserts
// current_setting('neon.branch_id') before anything else; a DATABASE_URL* variable in the environment stops the script,
// which never reads one. The API key, connection strings and the password are never printed.
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const TARGET_BRANCH = 'preview/feat/mcp-cli-login';
export const NEON_API = 'https://console.neon.tech/api/v2';
export const APP_ROLE = 'headjack_app';
export const QUOTA_CALLS = 61;
export const BUDGET_PER_MINUTE = 60;
export const MAX_BUDGET_ROWS = 2;
export const MAX_QUOTA_TRIES = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const MINUTE_POLL_MS = 1_000;
// The tables reset empties: the foreign-key closure of public.owners and public.blobs after every migration in drizzle/
// (db/schema.ts plus the hand-written app.blob_holders, app.owner_aliases and app.mcp_search_budget). Blobs reference
// no owner, but they hold the copied production tarballs, and the preview must keep only the synthetic users' data
// (spec D6). TRUNCATE … CASCADE reaches exactly these; reset refuses when the database's closure differs, so it never
// empties a table this list does not name.
export const RESET_TABLES = [
  'app.blob_holders',
  'app.mcp_search_budget',
  'app.owner_aliases',
  'public.blobs',
  'public.chunks',
  'public.install_events',
  'public.owners',
  'public.search_events',
  'public.skills',
  'public.sources',
  'public.upstream',
  'public.versions',
];

// Usage errors and guard refusals: nothing was changed. Exit code 2.
export class UserError extends Error {}

// GET against the Neon API v2; path → parsed JSON. Errors name the path and status only.
export function neonApi({ apiKey, fetchImpl = fetch }) {
  return async (path) => {
    const res = await fetchImpl(`${NEON_API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Neon API GET ${path.split('?')[0]} returned ${res.status}`);
    return res.json();
  };
}

// Finds the branch by exact name; refuses the production id and anything Neon marks default or primary.
export async function resolveBranch({ neon, projectId, name, productionBranchId }) {
  if (!productionBranchId) throw new UserError('the production branch id is required');
  const { branches = [] } = await neon(`/projects/${encodeURIComponent(projectId)}/branches`);
  const found = branches.filter((b) => b.name === name);
  if (found.length === 0) throw new UserError(`no branch named ${name} in project ${projectId}`);
  if (found.length > 1) throw new UserError(`${found.length} branches named ${name} in project ${projectId}`);
  const [branch] = found;
  if (branch.id === productionBranchId) throw new UserError(`refused: ${name} resolves to the production branch ${branch.id}`);
  if (branch.default || branch.primary) throw new UserError(`refused: Neon marks ${name} (${branch.id}) as the default or primary branch`);
  return { id: branch.id };
}

// The one database on the branch and its owner role, as the Neon API reports them.
async function branchDatabase({ neon, projectId, branchId }) {
  const { databases = [] } = await neon(`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`);
  if (databases.length !== 1) {
    throw new UserError(`expected exactly one database on ${branchId}, found ${databases.map((d) => d.name).join(', ') || 'none'}`);
  }
  return { database: databases[0].name, owner: databases[0].owner_name };
}

// Owner-role connection string for the branch id, from the Neon API only. The app role is NOLOGIN-created with a
// password set out of band, so Neon cannot return its URI.
export async function branchConnection({ neon, projectId, branchId, role }) {
  if (role !== 'owner') throw new UserError(`Neon returns connection strings for the owner role only, not ${role}`);
  const { database, owner } = await branchDatabase({ neon, projectId, branchId });
  const query = new URLSearchParams({ branch_id: branchId, database_name: database, role_name: owner });
  const { uri } = await neon(`/projects/${encodeURIComponent(projectId)}/connection_uri?${query}`);
  if (!uri) throw new Error(`Neon API returned no connection string for ${branchId}`);
  return uri;
}

// Host of the branch's read-write endpoint and its database name, for the app-role session.
export async function branchEndpoint({ neon, projectId, branchId }) {
  const { endpoints = [] } = await neon(`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/endpoints`);
  const rw = endpoints.filter((e) => e.type === 'read_write' && e.branch_id === branchId);
  if (rw.length !== 1) throw new UserError(`expected one read-write endpoint on ${branchId}, found ${rw.length}`);
  const { database } = await branchDatabase({ neon, projectId, branchId });
  return { host: rw[0].host, database };
}

// In-session guard: the compute this session reached serves the verified branch. Neon sets neon.branch_id on every
// compute (checked read-only on a preview branch of this project, 2026-10-11).
export async function assertBranch(client, branchId) {
  const { rows } = await client.query("select current_setting('neon.branch_id', true) as branch_id");
  const actual = rows[0]?.branch_id ?? null;
  if (actual !== branchId) throw new UserError(`refused: this session's neon.branch_id is ${actual ?? 'unset'}, not ${branchId}`);
}

// public.owners, public.blobs and every table whose rows depend on them through foreign keys, as schema.table.
const RESET_CLOSURE_SQL = `
  with recursive refs(oid) as (
    select unnest(array['public.owners'::regclass::oid, 'public.blobs'::regclass::oid])
    union
    select c.conrelid from pg_constraint c join refs r on c.confrelid = r.oid where c.contype = 'f'
  )
  select n.nspname || '.' || t.relname as name
  from refs join pg_class t on t.oid = refs.oid join pg_namespace n on n.oid = t.relnamespace
  order by 1`;

// One transaction: lock every table (so the counts are the rows removed), check the foreign-key closure, count each
// table, then a single TRUNCATE … CASCADE (separate DELETEs cannot work: skills and versions reference each other with
// non-deferrable keys).
export async function resetOwners(client) {
  await client.query('begin');
  try {
    await client.query(`lock table ${RESET_TABLES.join(', ')} in access exclusive mode`);
    const closure = (await client.query(RESET_CLOSURE_SQL)).rows.map((r) => r.name).sort();
    const unknown = closure.filter((t) => !RESET_TABLES.includes(t));
    const missing = RESET_TABLES.filter((t) => !closure.includes(t));
    if (unknown.length || missing.length) {
      throw new UserError(`refused: the tables that reference public.owners or public.blobs changed (unknown: ${unknown.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`);
    }
    const deleted = {};
    for (const table of RESET_TABLES) {
      deleted[table] = Number((await client.query(`select count(*)::bigint as n from ${table}`)).rows[0].n);
    }
    await client.query(`truncate ${RESET_TABLES.join(', ')} cascade`);
    await client.query('commit');
    return { deleted };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  }
}

// No owners other than the given user refs, and no owner aliases.
export async function checkClean(client, allowedRefs = []) {
  const { rows: [extra] } = await client.query(
    "select count(*)::int as n from public.owners where not (kind = 'user' and ref_id = any($1::text[]))",
    [allowedRefs],
  );
  const { rows: [aliases] } = await client.query('select count(*)::int as n from app.owner_aliases');
  const problems = [];
  if (Number(extra.n) > 0) problems.push(`${extra.n} owner(s) other than the synthetic users`);
  if (Number(aliases.n) > 0) problems.push(`${aliases.n} app.owner_aliases row(s)`);
  if (problems.length) throw new UserError(`not clean: ${problems.join('; ')}`);
}

// The database minute and whether the owner already has a counter row in it, read in one statement.
const MINUTE_SQL = `
  with m as (select date_trunc('minute', clock_timestamp()) as w)
  select m.w::text as minute,
    (select count(*)::int from app.mcp_search_budget b where b.owner_id = $1 and b.window_start = m.w) as current
  from m`;
const BUDGET_ROWS_SQL = 'select count(*)::int as n from app.mcp_search_budget where owner_id = $1';
const CONSUME_SQL = 'select allowed, retry_after from app.consume_mcp_search_budget()';
const OWNER_CONTEXT_SQL = "select set_config('app.owner_id', $1, false)";

const readMinute = async (owner, ownerId) => (await owner.query(MINUTE_SQL, [ownerId])).rows[0];

// Opens n app sessions (each asserted by connect) and only then sets the owner context, so a failed open or branch
// check leaves no session that touched data. Closes whatever opened when any fails.
async function openAppSessions(connect, ownerId, n) {
  const settled = await Promise.allSettled(Array.from({ length: n }, () => connect('app')));
  const sessions = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) {
    await closeAll(sessions);
    throw failed.reason;
  }
  try {
    await Promise.all(sessions.map((s) => s.query(OWNER_CONTEXT_SQL, [String(ownerId)])));
  } catch (e) {
    await closeAll(sessions);
    throw e;
  }
  return sessions;
}

const closeAll = (sessions) => Promise.all(sessions.map((s) => Promise.resolve(s.end()).catch(() => {})));
const consume = async (session) => (await session.query(CONSUME_SQL)).rows[0].allowed === true;

// connect('owner' | 'app') → a session { query, end } already asserted on the verified branch. The minute, the
// current-minute row check and the row count run on the owner session (the app role cannot read the budget table).
// A try that crosses a database minute is discarded, and the next one waits for a fresh minute first.
export async function quotaProbe({ connect, ownerId, otherOwnerId, attempts = QUOTA_CALLS, tries = MAX_QUOTA_TRIES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const owner = await connect('owner');
  try {
    let maxRows = 0;
    let lastMinute;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (attempt > 0) {
        while ((await readMinute(owner, ownerId)).minute === lastMinute) await sleep(MINUTE_POLL_MS);
      }
      const sessions = await openAppSessions(connect, ownerId, attempts);
      let results;
      let before;
      let after;
      try {
        before = await readMinute(owner, ownerId);
        if (Number(before.current) > 0) {
          throw new UserError('owner A already has a budget row in the current minute: run quota again in a fresh minute');
        }
        results = await Promise.all(sessions.map(consume));
        after = await readMinute(owner, ownerId);
      } finally {
        await closeAll(sessions);
      }
      maxRows = Math.max(maxRows, Number((await owner.query(BUDGET_ROWS_SQL, [ownerId])).rows[0].n));
      if (before.minute === after.minute) {
        const [other] = await openAppSessions(connect, otherOwnerId, 1);
        let otherAllowed;
        try { otherAllowed = await consume(other); } finally { await closeAll([other]); }
        const allowed = results.filter(Boolean).length;
        return { allowed, denied: results.length - allowed, otherAllowed, maxRows };
      }
      lastMinute = after.minute;
    }
    throw new Error(`quota probe crossed a database minute in all ${tries} tries`);
  } finally {
    await Promise.resolve(owner.end()).catch(() => {});
  }
}

// Reads one line from stdin; on a terminal the characters are not echoed.
export async function readHiddenLine(prompt, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) {
    let data = '';
    stdin.setEncoding('utf8');
    for await (const chunk of stdin) data += chunk;
    return data.split(/\r?\n/)[0];
  }
  stderr.write(prompt);
  stdin.setEncoding('utf8');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new UserError('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
      return undefined;
    };
    stdin.on('data', onData);
  });
}

async function openNeonClient(config) {
  const { Client, neonConfig } = await import('@neondatabase/serverless');
  if (!neonConfig.webSocketConstructor && globalThis.WebSocket) neonConfig.webSocketConstructor = globalThis.WebSocket;
  const client = new Client(config);
  await client.connect();
  return client;
}

// Opens a session and asserts its branch before handing it out; closes it when the assertion fails.
async function openOnBranch(open, config, branchId) {
  const client = await open(config);
  try {
    await assertBranch(client, branchId);
  } catch (e) {
    await Promise.resolve(client.end()).catch(() => {});
    throw e;
  }
  return client;
}

const USAGE = 'usage: acceptance-db.mjs reset|check|quota --branch <name> --project <id> --production-branch <id> '
  + '--neon-key-file <path> [--owner-ref clerk:user_… --other-ref clerk:user_…]';
const REQUIRED_FLAGS = ['--branch', '--project', '--production-branch', '--neon-key-file'];
const VALUE_FLAGS = { '--branch': 'branch', '--project': 'project', '--production-branch': 'productionBranch', '--neon-key-file': 'keyFile', '--owner-ref': 'ownerRef', '--other-ref': 'otherRef' };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['reset', 'check', 'quota'].includes(command)) throw new UserError(USAGE);
  const options = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const key = VALUE_FLAGS[rest[i]];
    if (!key) throw new UserError(`unknown argument ${rest[i]}\n${USAGE}`);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new UserError(`${rest[i]} needs a value`);
    options[key] = value;
    i += 1;
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!options[VALUE_FLAGS[flag]]) throw new UserError(`${flag} is required\n${USAGE}`);
  }
  if (options.branch !== TARGET_BRANCH) throw new UserError(`refused: --branch must be ${TARGET_BRANCH}`);
  if (command === 'quota' && (!options.ownerRef || !options.otherRef)) throw new UserError('quota needs --owner-ref and --other-ref');
  return options;
}

async function ownerIdOf(client, ref) {
  const { rows } = await client.query("select id from public.owners where kind = 'user' and ref_id = $1", [ref]);
  if (!rows.length) throw new UserError(`no owner with ref ${ref} on this branch yet (owners are created on first request)`);
  return Number(rows[0].id);
}

// Exit codes: 0 done, 1 failure, 2 usage error or a guard refused (nothing was changed).
export async function main(argv, {
  env = process.env,
  fetchImpl = fetch,
  open = openNeonClient,
  readPassword = () => readHiddenLine(`${APP_ROLE} password: `),
  sleep,
  log = console.log,
  error = console.error,
} = {}) {
  const secrets = [];
  const redact = (text) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('[redacted]'), String(text));
  try {
    const pulled = Object.keys(env).filter((name) => name.startsWith('DATABASE_URL'));
    if (pulled.length) throw new UserError(`refused: unset ${pulled.join(', ')} first; this script never uses a database URL from the environment`);
    const options = parseArgs(argv);
    const apiKey = (await readFile(options.keyFile, 'utf8')).trim();
    if (!apiKey) throw new UserError(`${options.keyFile} is empty`);
    secrets.push(apiKey);
    const neon = neonApi({ apiKey, fetchImpl });
    const { id: branchId } = await resolveBranch({ neon, projectId: options.project, name: options.branch, productionBranchId: options.productionBranch });
    const ownerUri = await branchConnection({ neon, projectId: options.project, branchId, role: 'owner' });
    secrets.push(ownerUri, safePassword(ownerUri));
    const owner = await openOnBranch(open, { connectionString: ownerUri }, branchId);
    try {
      if (options.command === 'reset') {
        const { deleted } = await resetOwners(owner);
        log(`reset ${options.branch} (${branchId}); rows deleted:`);
        for (const [table, n] of Object.entries(deleted)) log(`  ${table.padEnd(24)} ${n}`);
        return 0;
      }
      if (options.command === 'check') {
        await checkClean(owner, [options.ownerRef, options.otherRef].filter(Boolean));
        log(`${options.branch} (${branchId}) is clean: no other owners, no owner aliases`);
        return 0;
      }
      const ownerId = await ownerIdOf(owner, options.ownerRef);
      const otherOwnerId = await ownerIdOf(owner, options.otherRef);
      const { host, database } = await branchEndpoint({ neon, projectId: options.project, branchId });
      const password = await readPassword();
      if (!password) throw new UserError(`no ${APP_ROLE} password on stdin`);
      secrets.push(password);
      const connect = (kind) => openOnBranch(open, kind === 'owner'
        ? { connectionString: ownerUri }
        : { host, database, user: APP_ROLE, password }, branchId);
      const result = await quotaProbe({ connect, ownerId, otherOwnerId, ...(sleep ? { sleep } : {}) });
      const ok = result.allowed === BUDGET_PER_MINUTE && result.denied === QUOTA_CALLS - BUDGET_PER_MINUTE
        && result.otherAllowed && result.maxRows <= MAX_BUDGET_ROWS;
      log(`quota on ${options.branch} (${branchId}): allowed ${result.allowed}, denied ${result.denied}, `
        + `other owner allowed ${result.otherAllowed}, owner A budget rows at most ${result.maxRows}: ${ok ? 'PASS' : 'FAIL'}`);
      return ok ? 0 : 1;
    } finally {
      await Promise.resolve(owner.end()).catch(() => {});
    }
  } catch (e) {
    const message = e?.message || (e?.type ? `could not connect (${e.type})` : String(e));
    error(redact(message));
    return e instanceof UserError ? 2 : 1;
  }
}

// The password inside a connection string, for redaction; empty when it has none or does not parse.
function safePassword(uri) {
  try { return decodeURIComponent(new URL(uri).password); } catch { return ''; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
