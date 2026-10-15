// Guards of scripts/acceptance-db.mjs (spec D6, §6 step 5): each one must stop the script before any data statement.
// Neon ids here are made up; the real project and production branch ids never enter the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePg, migratedPg, vecText } from '../pglite.mjs';
import {
  RESET_TABLES,
  TARGET_BRANCH,
  assertBranch,
  branchConnection,
  checkClean,
  main,
  quotaProbe,
  resetOwners,
  resolveBranch,
} from '../../scripts/acceptance-db.mjs';

const PROJECT = 'proj-fake-123';
const PROD = 'br-fake-production';
const TARGET = 'br-fake-target';
const API_KEY = ['neon', 'fake', 'key', 'abc'].join('-');
// Built from parts so no `scheme://user:pass@` literal sits in the source.
const OWNER_PASSWORD = ['fake', 'owner', 'pw'].join('');
const OWNER_URI = `postgresql://neondb_owner:${OWNER_PASSWORD}@ep-fake-target.example.test/neondb?sslmode=require`;
const APP_PASSWORD = ['fake', 'app', 'pw'].join('');

const branches = (overrides = {}) => [
  { id: PROD, name: 'main', default: true, primary: true },
  { id: 'br-fake-other', name: 'preview/feat/other', default: false, primary: false },
  { id: TARGET, name: TARGET_BRANCH, default: false, primary: false, ...overrides },
];

// Neon API v2 fake, keyed by path; records every request.
function fakeNeon({ branchList = branches(), databases = [{ name: 'neondb', owner_name: 'neondb_owner' }] } = {}) {
  const requests = [];
  const routes = {
    [`/projects/${PROJECT}/branches`]: () => ({ branches: branchList }),
    [`/projects/${PROJECT}/branches/${TARGET}/databases`]: () => ({ databases }),
    [`/projects/${PROJECT}/branches/${TARGET}/endpoints`]: () => ({
      endpoints: [
        { id: 'ep-fake-ro', type: 'read_only', branch_id: TARGET, host: 'ep-fake-ro.example.test' },
        { id: 'ep-fake-target', type: 'read_write', branch_id: TARGET, host: 'ep-fake-target.example.test' },
      ],
    }),
    [`/projects/${PROJECT}/connection_uri`]: (q) => {
      assert.equal(q.get('branch_id'), TARGET);
      assert.equal(q.get('database_name'), databases[0].name);
      assert.equal(q.get('role_name'), databases[0].owner_name);
      return { uri: OWNER_URI };
    },
  };
  const neon = async (p) => {
    const url = new URL(p, 'https://neon.invalid');
    requests.push(p);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected Neon path ${url.pathname}`);
    return route(url.searchParams);
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.ok(String(url).startsWith('https://console.neon.tech/api/v2/'), String(url));
    assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
    const body = await neon(u.pathname.replace(/^\/api\/v2/, '') + u.search);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { neon, fetchImpl, requests };
}

// A database session double: answers the branch probe, owner lookups and the budget, and logs every statement.
function fakeDatabase({ branchId = TARGET, minutes = [1], owners = { 'clerk:user_A1': 11, 'clerk:user_B1': 22 }, budget = [] } = {}) {
  const state = { log: [], opened: [], ended: 0, current: undefined, rows: new Map(budget.map(([o, m, u]) => [`${o}:${m}`, u])), sleeps: 0 };
  const readMinute = () => { state.current = minutes.length > 1 ? minutes.shift() : minutes[0]; return state.current; };
  const rowsOf = (owner) => [...state.rows.keys()].filter((k) => k.startsWith(`${owner}:`));
  function client(kind, config) {
    let ownerCtx = null;
    const statements = [];
    return {
      kind,
      config,
      statements,
      async query(text, params = []) {
        state.log.push({ kind, text });
        statements.push(text);
        if (/neon\.branch_id/.test(text)) return { rows: [{ branch_id: branchId }] };
        if (/set_config\('app\.owner_id'/.test(text)) { ownerCtx = Number(params[0]); return { rows: [{ set_config: params[0] }] }; }
        if (/consume_mcp_search_budget/.test(text)) {
          assert.equal(kind, 'app', 'the budget is consumed by the app role only');
          for (const k of rowsOf(ownerCtx)) if (Number(k.split(':')[1]) < state.current - 1) state.rows.delete(k);
          const key = `${ownerCtx}:${state.current}`;
          const used = (state.rows.get(key) ?? 0) + 1;
          state.rows.set(key, used);
          return { rows: [{ allowed: used <= 60, retry_after: used <= 60 ? 0 : 30 }] };
        }
        if (/date_trunc\('minute'/.test(text)) {
          assert.equal(kind, 'owner', 'the minute and current-row check run on the owner session');
          const m = readMinute();
          return { rows: [{ minute: String(m), current: state.rows.has(`${params[0]}:${m}`) ? 1 : 0 }] };
        }
        if (/from app\.mcp_search_budget/.test(text)) {
          assert.equal(kind, 'owner', 'the row count runs on the owner session');
          return { rows: [{ n: rowsOf(Number(params[0])).length }] };
        }
        if (/from public\.owners/.test(text)) {
          const id = owners[params[0]];
          return { rows: id ? [{ id: String(id) }] : [] };
        }
        throw new Error(`unexpected statement ${text}`);
      },
      async end() { state.ended += 1; },
    };
  }
  const connect = async (kind) => { const c = client(kind); state.opened.push(c); return c; };
  const open = async (config) => {
    const c = client(config.connectionString ? 'owner' : 'app', config);
    state.opened.push(c);
    return c;
  };
  return { state, connect, open, sleep: async () => { state.sleeps += 1; } };
}

async function keyFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'acc-db-'));
  const file = path.join(dir, 'api-key');
  await writeFile(file, `${API_KEY}\n`, { mode: 0o600 });
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
}

const baseArgs = (cmd, file, extra = []) => [cmd, '--branch', TARGET_BRANCH, '--project', PROJECT, '--production-branch', PROD, '--neon-key-file', file, ...extra];

// ---- Neon lookups -------------------------------------------------------------------------------------------------

test('resolveBranch finds the branch by exact name and returns its id', async () => {
  const { neon } = fakeNeon();
  assert.deepEqual(await resolveBranch({ neon, projectId: PROJECT, name: TARGET_BRANCH, productionBranchId: PROD }), { id: TARGET });
});

test('production branch id is refused', async () => {
  const { neon } = fakeNeon({ branchList: [{ id: PROD, name: TARGET_BRANCH, default: false, primary: false }] });
  await assert.rejects(resolveBranch({ neon, projectId: PROJECT, name: TARGET_BRANCH, productionBranchId: PROD }), /production/);
});

test('a branch Neon marks default or primary is refused even when --production-branch is wrong', async () => {
  for (const flags of [{ default: true }, { primary: true }]) {
    const { neon } = fakeNeon({ branchList: branches(flags) });
    await assert.rejects(
      resolveBranch({ neon, projectId: PROJECT, name: TARGET_BRANCH, productionBranchId: 'br-fake-wrong-value' }),
      /default or primary/,
    );
  }
});

test('resolveBranch refuses a missing or ambiguous name, and a prefix is not a match', async () => {
  const missing = fakeNeon({ branchList: [{ id: 'br-x', name: `${TARGET_BRANCH}-old`, default: false, primary: false }] });
  await assert.rejects(resolveBranch({ neon: missing.neon, projectId: PROJECT, name: TARGET_BRANCH, productionBranchId: PROD }), /no branch named/);
  const twice = fakeNeon({ branchList: [...branches(), { id: 'br-y', name: TARGET_BRANCH, default: false, primary: false }] });
  await assert.rejects(resolveBranch({ neon: twice.neon, projectId: PROJECT, name: TARGET_BRANCH, productionBranchId: PROD }), /2 branches named/);
});

test('branchConnection asks Neon for the owner URI of that branch id, with names read from the branch databases', async () => {
  const { neon, requests } = fakeNeon({ databases: [{ name: 'appdb', owner_name: 'appdb_owner' }] });
  assert.equal(await branchConnection({ neon, projectId: PROJECT, branchId: TARGET, role: 'owner' }), OWNER_URI);
  assert.deepEqual(requests, [
    `/projects/${PROJECT}/branches/${TARGET}/databases`,
    `/projects/${PROJECT}/connection_uri?branch_id=${TARGET}&database_name=appdb&role_name=appdb_owner`,
  ]);
  await assert.rejects(branchConnection({ neon, projectId: PROJECT, branchId: TARGET, role: 'headjack_app' }), /owner/);
  const two = fakeNeon({ databases: [{ name: 'a', owner_name: 'o' }, { name: 'b', owner_name: 'o' }] });
  await assert.rejects(branchConnection({ neon: two.neon, projectId: PROJECT, branchId: TARGET, role: 'owner' }), /exactly one database/);
});

test('assertBranch passes on the verified id and fails on another or a missing setting', async () => {
  const session = (value) => ({ query: async () => ({ rows: [{ branch_id: value }] }) });
  await assertBranch(session(TARGET), TARGET);
  await assert.rejects(assertBranch(session(PROD), TARGET), /neon\.branch_id/);
  await assert.rejects(assertBranch(session(null), TARGET), /neon\.branch_id/);
});

// ---- main: guards before any data statement ---------------------------------------------------------------------

test('a pulled DATABASE_URL in the environment is refused', async () => {
  const { file, cleanup } = await keyFile();
  try {
    for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_URL_OWNER']) {
      const io = capture();
      const neon = fakeNeon();
      const db = fakeDatabase();
      const code = await main(baseArgs('reset', file), { env: { [name]: 'set' }, fetchImpl: neon.fetchImpl, open: db.open, ...io });
      assert.equal(code, 2);
      assert.match(io.err.join('\n'), new RegExp(name));
      assert.deepEqual(neon.requests, []);
      assert.equal(db.state.opened.length, 0);
    }
  } finally { await cleanup(); }
});

test('missing --project or --production-branch is a usage error before any request', async () => {
  const { file, cleanup } = await keyFile();
  try {
    const full = baseArgs('check', file);
    for (const flag of ['--project', '--production-branch', '--neon-key-file', '--branch']) {
      const i = full.indexOf(flag);
      const argv = [...full.slice(0, i), ...full.slice(i + 2)];
      const io = capture();
      const neon = fakeNeon();
      const db = fakeDatabase();
      assert.equal(await main(argv, { env: {}, fetchImpl: neon.fetchImpl, open: db.open, ...io }), 2, flag);
      assert.match(io.err.join('\n'), new RegExp(flag));
      assert.deepEqual(neon.requests, []);
      assert.equal(db.state.opened.length, 0);
    }
    const io = capture();
    assert.equal(await main(['wipe', ...full.slice(1)], { env: {}, fetchImpl: fakeNeon().fetchImpl, ...io }), 2);
    const other = capture();
    assert.equal(await main(['check', '--branch', 'preview/feat/other', ...full.slice(3)], { env: {}, fetchImpl: fakeNeon().fetchImpl, ...other }), 2);
  } finally { await cleanup(); }
});

test('main refuses the production branch and a default branch before opening a session', async () => {
  const { file, cleanup } = await keyFile();
  try {
    for (const branchList of [
      [{ id: PROD, name: TARGET_BRANCH, default: false, primary: false }],
      branches({ default: true }),
    ]) {
      const io = capture();
      const neon = fakeNeon({ branchList });
      const db = fakeDatabase();
      assert.equal(await main(baseArgs('reset', file), { env: {}, fetchImpl: neon.fetchImpl, open: db.open, ...io }), 2);
      assert.equal(db.state.opened.length, 0);
      assert.deepEqual(neon.requests, [`/projects/${PROJECT}/branches`]);
    }
  } finally { await cleanup(); }
});

test('neon.branch_id mismatch aborts before any delete', async () => {
  const { file, cleanup } = await keyFile();
  try {
    for (const cmd of ['reset', 'check']) {
      const io = capture();
      const neon = fakeNeon();
      const db = fakeDatabase({ branchId: PROD });
      assert.equal(await main(baseArgs(cmd, file), { env: {}, fetchImpl: neon.fetchImpl, open: db.open, ...io }), 2);
      assert.equal(db.state.log.length, 1, 'only the branch probe ran');
      assert.match(db.state.log[0].text, /current_setting\('neon\.branch_id'/);
      assert.equal(db.state.opened[0].config.connectionString, OWNER_URI);
      assert.equal(db.state.ended, 1, 'the session is closed');
      assert.match(io.err.join('\n'), /neon\.branch_id/);
    }
  } finally { await cleanup(); }
});

test('the API key, the connection URI and its password never reach the output', async () => {
  const { file, cleanup } = await keyFile();
  try {
    const io = capture();
    const neon = fakeNeon();
    const open = async (config) => { throw new Error(`could not connect to ${config.connectionString} with ${API_KEY}`); };
    assert.equal(await main(baseArgs('check', file), { env: {}, fetchImpl: neon.fetchImpl, open, ...io }), 1);
    const all = [...io.out, ...io.err].join('\n');
    assert.ok(all.length > 0);
    for (const secret of [API_KEY, OWNER_URI, OWNER_PASSWORD]) assert.ok(!all.includes(secret), 'secret leaked');
  } finally { await cleanup(); }
});

// ---- reset and check on a migrated, seeded database ---------------------------------------------------------------

async function seeded() {
  const pg = await migratedPg();
  // The migrations already create owner 1, legacy:v1.
  await pg.exec(`
    insert into owners (kind, ref_id) values ('user', 'clerk:user_A1'), ('user', 'clerk:user_B1');
    insert into app.owner_aliases (kind, ref_id, owner_id) values ('user', 'clerk:user_Alias1', 1);
    select set_config('app.owner_id', '2', false);
  `);
  const { rows: [{ h }] } = await pg.query('select app.put_blob($1) as h', [Buffer.from('tarball-bytes')]);
  await pg.exec(`
    insert into sources (owner_id, kind, url) values (2, 'github', 'https://github.com/x/y');
    insert into skills (owner_id, slug, name, description, kind, source_id) values (2, 's', 's', 'd', 'skill', 1);
    insert into versions (owner_id, skill_id, sha256, blob_sha256, size, status) values (2, 1, '${'1'.repeat(64)}', '${h}', 13, 'approved');
    update skills set current_version_id = 1 where id = 1;
    insert into chunks (owner_id, skill_id, version_id, text, embedding) values (2, 1, 1, 'd', '${vecText(0)}');
    insert into upstream (owner_id, skill_id) values (2, 1);
    insert into install_events (owner_id, session_id, slug, kind, source) values (2, 's1', 's', 'skill', 'suggest');
    insert into search_events (owner_id, session_id, variant, query_hmac, top_slugs) values (2, 's1', 'v', 'h', '{s}');
    insert into app.mcp_search_budget (owner_id, window_start, used) values (3, date_trunc('minute', now()), 4);
    select set_config('app.owner_id', '', false);
  `);
  return pg;
}

const countAll = async (pg) => Object.fromEntries(await Promise.all(RESET_TABLES.map(async (t) =>
  [t, (await pg.query(`select count(*)::int as n from ${t}`)).rows[0].n])));

// Records the statements resetOwners sends, optionally failing one.
const recording = (pg, failOn) => {
  const sent = [];
  const texts = [];
  return {
    sent,
    texts,
    query: async (text, params) => {
      sent.push(text.trim().split(/\s+/)[0].toLowerCase());
      texts.push(text.trim());
      if (failOn && failOn.test(text)) throw new Error('injected failure');
      return pg.query(text, params);
    },
  };
};

test('reset empties every owner-scoped table on a seeded database', async () => {
  const pg = await seeded();
  try {
    const before = await countAll(pg);
    assert.ok(Object.values(before).every((n) => n > 0), JSON.stringify(before));
    const client = recording(pg);
    const { deleted } = await resetOwners(client);
    assert.deepEqual(deleted, before);
    assert.equal(deleted['public.owners'], 3);
    assert.equal(deleted['app.blob_holders'], 1);
    assert.equal(deleted['app.owner_aliases'], 1);
    assert.equal(deleted['public.blobs'], 1);
    assert.deepEqual(Object.values(await countAll(pg)), RESET_TABLES.map(() => 0));
    assert.equal(client.sent[0], 'begin');
    // Every table is locked before anything is counted, so the printed counts are the rows removed.
    assert.equal(client.sent[1], 'lock');
    assert.equal(client.texts[1], `lock table ${RESET_TABLES.join(', ')} in access exclusive mode`);
    const firstCount = client.texts.findIndex((t) => /^select count\(\*\)/.test(t));
    assert.ok(firstCount > 1, 'counts come after the lock');
    assert.equal(client.sent.at(-1), 'commit');
    assert.equal(client.sent.filter((s) => s === 'truncate').length, 1, 'one TRUNCATE ... CASCADE, no DELETEs');
    assert.ok(!client.sent.includes('delete'));
    // Blobs reference no owner but hold production tarballs: the preview keeps only the synthetic users' data (D6).
    assert.equal((await pg.query('select count(*)::int as n from blobs')).rows[0].n, 0);
    assert.ok(RESET_TABLES.includes('public.blobs'));
  } finally { await closePg(pg); }
});

test('reset rolls back when a statement fails', async () => {
  const pg = await seeded();
  try {
    const before = await countAll(pg);
    const client = recording(pg, /^\s*truncate/i);
    await assert.rejects(resetOwners(client), /injected failure/);
    assert.equal(client.sent.at(-1), 'rollback');
    assert.deepEqual(await countAll(pg), before);
  } finally { await closePg(pg); }
});

test('reset refuses when the owners foreign-key closure has a table it does not know', async () => {
  const pg = await seeded();
  try {
    await pg.exec('create table public.extra_notes (owner_id bigint references public.owners (id))');
    const before = await countAll(pg);
    const client = recording(pg);
    await assert.rejects(resetOwners(client), /public\.extra_notes/);
    assert.ok(!client.sent.includes('truncate'));
    assert.deepEqual(await countAll(pg), before);
  } finally { await closePg(pg); }
});

test('check fails with an extra owner or an alias row, and passes when clean', async () => {
  const pg = await seeded();
  try {
    await assert.rejects(checkClean(pg, ['clerk:user_A1', 'clerk:user_B1']), /1 owner/);
    await pg.exec("delete from app.owner_aliases; truncate public.owners cascade; insert into owners (kind, ref_id) values ('user', 'clerk:user_A1')");
    await checkClean(pg, ['clerk:user_A1', 'clerk:user_B1']);
    await checkClean(pg, ['clerk:user_A1']);
    await assert.rejects(checkClean(pg), /1 owner/);
    await pg.exec("insert into app.owner_aliases (kind, ref_id, owner_id) select 'user', 'clerk:user_Alias1', id from owners");
    await assert.rejects(checkClean(pg, ['clerk:user_A1']), /owner_aliases/);
    await pg.exec("delete from app.owner_aliases; insert into owners (kind, ref_id) values ('org', 'clerk:user_A1')");
    await assert.rejects(checkClean(pg, ['clerk:user_A1']), /1 owner/, 'an org with a synthetic ref is still extra');
  } finally { await closePg(pg); }
});

// ---- quota ------------------------------------------------------------------------------------------------------

test('quotaProbe reports 60/1 with a fake budget function', async () => {
  const db = fakeDatabase({ budget: [[11, 0, 5]] });
  const result = await quotaProbe({ connect: db.connect, ownerId: 11, otherOwnerId: 22, sleep: db.sleep });
  assert.deepEqual(result, { allowed: 60, denied: 1, otherAllowed: true, maxRows: 2 });
  const app = db.state.opened.filter((c) => c.kind === 'app');
  assert.equal(app.length, 62, '61 sessions for A and one for B');
  assert.equal(db.state.ended, db.state.opened.length, 'every session is closed');
  assert.equal(db.state.sleeps, 0);
});

test('quotaProbe retries when the minute changes', async () => {
  const db = fakeDatabase({ minutes: [1, 2, 2, 3] });
  const result = await quotaProbe({ connect: db.connect, ownerId: 11, otherOwnerId: 22, sleep: db.sleep });
  assert.deepEqual(result, { allowed: 60, denied: 1, otherAllowed: true, maxRows: 1 });
  assert.equal(db.state.sleeps, 1, 'waited for a fresh minute before the second try');
  assert.equal(db.state.log.filter((l) => /consume_mcp_search_budget/.test(l.text)).length, 61 * 2 + 1);
});

test('quotaProbe fails after crossing a minute on every try', async () => {
  const db = fakeDatabase({ minutes: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  await assert.rejects(quotaProbe({ connect: db.connect, ownerId: 11, otherOwnerId: 22, sleep: db.sleep }), /crossed a database minute in all 3 tries/);
  assert.equal(db.state.ended, db.state.opened.length);
});

test('quotaProbe refuses when A already has a current-minute budget row, before any call', async () => {
  const db = fakeDatabase({ budget: [[11, 1, 3]] });
  await assert.rejects(quotaProbe({ connect: db.connect, ownerId: 11, otherOwnerId: 22, sleep: db.sleep }), /current minute/);
  assert.equal(db.state.log.filter((l) => /consume_mcp_search_budget/.test(l.text)).length, 0);
  assert.equal(db.state.ended, db.state.opened.length);
});

test('main quota uses the verified endpoint host, the app role and a stdin password, asserting every session', async () => {
  const { file, cleanup } = await keyFile();
  try {
    const io = capture();
    const neon = fakeNeon();
    const db = fakeDatabase();
    const code = await main(baseArgs('quota', file, ['--owner-ref', 'clerk:user_A1', '--other-ref', 'clerk:user_B1']), {
      env: {}, fetchImpl: neon.fetchImpl, open: db.open, readPassword: async () => APP_PASSWORD, sleep: db.sleep, ...io,
    });
    assert.equal(code, 0, io.err.join('\n'));
    const app = db.state.opened.filter((c) => c.kind === 'app');
    assert.equal(app.length, 62);
    for (const c of app) {
      assert.deepEqual(c.config, { host: 'ep-fake-target.example.test', database: 'neondb', user: 'headjack_app', password: APP_PASSWORD });
    }
    // Every session, owner and app, runs the branch probe as its first statement.
    for (const c of db.state.opened) assert.match(c.statements[0], /current_setting\('neon\.branch_id'/);
    assert.match(io.out.join('\n'), /allowed 60, denied 1/);
    assert.ok(![...io.out, ...io.err].join('\n').includes(APP_PASSWORD));
  } finally { await cleanup(); }
});

test('main quota fails on a branch mismatch in an app session before any budget call', async () => {
  const { file, cleanup } = await keyFile();
  try {
    const io = capture();
    const neon = fakeNeon();
    const db = fakeDatabase();
    let opened = 0;
    // The owner session is on the verified branch; app sessions land elsewhere.
    const open = async (config) => {
      const c = await db.open(config);
      if (!config.connectionString) {
        opened += 1;
        const q = c.query;
        c.query = (text, params) => (/neon\.branch_id/.test(text) ? Promise.resolve({ rows: [{ branch_id: PROD }] }) : q(text, params));
      }
      return c;
    };
    const code = await main(baseArgs('quota', file, ['--owner-ref', 'clerk:user_A1', '--other-ref', 'clerk:user_B1']), {
      env: {}, fetchImpl: neon.fetchImpl, open, readPassword: async () => APP_PASSWORD, sleep: db.sleep, ...io,
    });
    assert.equal(code, 2);
    assert.ok(opened > 0);
    assert.equal(db.state.log.filter((l) => /consume_mcp_search_budget|set_config/.test(l.text)).length, 0);
    assert.equal(db.state.ended, db.state.opened.length);
  } finally { await cleanup(); }
});

test('main quota needs both owner refs and refuses an unknown owner', async () => {
  const { file, cleanup } = await keyFile();
  try {
    const io = capture();
    const neon = fakeNeon();
    assert.equal(await main(baseArgs('quota', file, ['--owner-ref', 'clerk:user_A1']), { env: {}, fetchImpl: neon.fetchImpl, ...io }), 2);
    assert.deepEqual(neon.requests, []);
    const db = fakeDatabase();
    const io2 = capture();
    const code = await main(baseArgs('quota', file, ['--owner-ref', 'clerk:user_A1', '--other-ref', 'clerk:user_Zz9']), {
      env: {}, fetchImpl: fakeNeon().fetchImpl, open: db.open, readPassword: async () => APP_PASSWORD, sleep: db.sleep, ...io2,
    });
    assert.equal(code, 2);
    assert.match(io2.err.join('\n'), /no owner/);
    assert.equal(db.state.opened.filter((c) => c.kind === 'app').length, 0);
  } finally { await cleanup(); }
});

test('main reset prints the counts it deleted', async () => {
  const { file, cleanup } = await keyFile();
  const pg = await seeded();
  try {
    const io = capture();
    const neon = fakeNeon();
    // The PGlite session answers the branch probe as the verified branch.
    const open = async () => ({
      query: (text, params) => (/neon\.branch_id/.test(text) ? Promise.resolve({ rows: [{ branch_id: TARGET }] }) : pg.query(text, params)),
      end: async () => {},
    });
    assert.equal(await main(baseArgs('reset', file), { env: {}, fetchImpl: neon.fetchImpl, open, ...io }), 0, io.err.join('\n'));
    const out = io.out.join('\n');
    assert.match(out, /public\.owners\s+3/);
    assert.match(out, /app\.blob_holders\s+1/);
    assert.match(out, /public\.blobs\s+1/);
    assert.match(out, new RegExp(TARGET));
    assert.deepEqual(Object.values(await countAll(pg)), RESET_TABLES.map(() => 0));
  } finally { await closePg(pg); await cleanup(); }
});
