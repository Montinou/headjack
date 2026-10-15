import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { createRepo, repoForOwner } from '../../lib/repo.mjs';
import { appPool, migratedPg, closePg, rowsOf, migrateThrough, newPg } from '../pglite.mjs';

async function fixture() {
  const pg = await migratedPg();
  const pool = appPool(pg);
  const db = createDb(pool);
  const owner = await db.resolveOwner('user', 'mcp-own');
  const foreign = await db.resolveOwner('user', 'mcp-foreign');
  return { pg, pool, db, owner, foreign, repo: repoForOwner(db.withOwner, owner), other: repoForOwner(db.withOwner, foreign) };
}

const orderedSlugs = ['A', 'Z', 'a', ...Array.from({ length: 46 }, (_, i) => `item-${String(i).padStart(2, '0')}`), 'z', 'é', '😀'];

// Catches missing RLS, locale ordering, offset pagination, default-limit changes and post-limit filtering.
test('MCP catalog pages 52 own skills in C order with disjoint keysets and filters before limit', async () => {
  const { pg, owner, foreign, repo } = await fixture();
  try {
    for (const id of [owner, foreign]) {
      for (const slug of orderedSlugs) {
        const tagged = ['item-44', 'z', 'é'].includes(slug);
        await pg.query('insert into skills(owner_id,slug,name,description,kind,tags) values ($1,$2,$3,$4,$5,$6)',
          [id, slug, id === owner ? 'Own' : 'Foreign', 'Catalog metadata', tagged ? 'plugin' : 'skill', tagged ? ['target'] : []]);
      }
    }
    const first = await repo.listMcpSkills();
    assert.equal(first.length, 51);
    assert.deepEqual(first.map((s) => s.slug), orderedSlugs.slice(0, 51));
    assert.ok(first.every((s) => s.name === 'Own'));
    assert.ok(first.every((s) => !['tarball', 'data', 'body', 'text', 'embedding'].some((key) => key in s)));
    const last = await repo.listMcpSkills({ after: first.at(-1).slug });
    assert.deepEqual(last.map((s) => s.slug), ['😀']);
    assert.deepEqual(await repo.listMcpSkills({ after: '😀' }), []);
    assert.deepEqual((await repo.listMcpSkills({ tag: 'target', kind: 'plugin', limit: 2 })).map((s) => s.slug), ['item-44', 'z']);
    assert.deepEqual((await repo.listMcpSkills({ tag: 'target', after: 'z' })).map((s) => s.slug), ['é']);
    assert.equal((await repo.listMcpSkills({ kind: 'skill', limit: 100 })).length, 49);
    assert.deepEqual(await repo.listMcpSkills({ tag: 'target', kind: 'skill' }), []);
    assert.deepEqual(await repo.listMcpSkills({ tag: 'missing' }), []);
    await pg.query('insert into upstream(skill_id,owner_id,latest_commit,update_available) select id,owner_id,$2,true from skills where owner_id=$1 and slug=$3', [owner, 'new-commit', 'A']);
    const [updated] = await repo.listMcpSkills({ limit: 1 });
    assert.equal(updated.update_available, true);
    assert.equal(updated.latest_commit, 'new-commit');
  } finally { await closePg(pg); }
});

test('MCP catalog and lookup expose no rows with unset or empty owner context', async () => {
  const { pg, pool, owner, repo } = await fixture();
  try {
    await pg.query("insert into skills(owner_id,slug,name,description,kind) values ($1,'A','Own','Visible with owner','skill')", [owner]);
    assert.equal((await repo.listMcpSkills()).length, 1);
    assert.equal((await repo.getMcpSkill('A')).metadata.name, 'Own');
    const anonymous = createRepo(pool);
    assert.deepEqual(await anonymous.listMcpSkills(), []);
    assert.equal(await anonymous.getMcpSkill('A'), null);
    await pool.query("select set_config('app.owner_id', '', false)");
    assert.deepEqual(await anonymous.listMcpSkills(), []);
    assert.equal(await anonymous.getMcpSkill('A'), null);
  } finally { await closePg(pg); }
});

const manifest = (sha256, name = 'First') => ({ slug: 'shared', name, description: 'Versioned metadata', kind: 'skill',
  tags: ['test'], source: { kind: 'github', url: 'https://github.com/test/mcp' }, source_path: 'skills/shared',
  commit_sha: sha256.slice(0, 40), sha256, status: 'approved', review_notes: name, scan_flags: [] });

// A split metadata/blob read or use of the latest instead of current version fails this contract.
test('MCP lookup returns same-current-version metadata and private tarball in one query under RLS', async () => {
  const { pg, db, owner, repo, other } = await fixture();
  try {
    await repo.publish({ manifest: manifest('1'.repeat(64)), tarball: Buffer.from('archive-one'), chunks: [] });
    await other.publish({ manifest: manifest('f'.repeat(64), 'Foreign'), tarball: Buffer.from('foreign-archive'), chunks: [] });
    await repo.publish({ manifest: { ...manifest('2'.repeat(64), 'Rejected'), status: 'rejected' }, tarball: Buffer.from('rejected-archive'), chunks: [] });
    let queries = 0;
    const first = await db.withOwner(owner, (tx) => createRepo({ query: (...args) => { queries++; return tx.query(...args); } }).getMcpSkill('shared'));
    assert.equal(queries, 1, 'one SQL snapshot for metadata and archive');
    assert.deepEqual(Object.keys(first).sort(), ['metadata', 'tarball']);
    assert.deepEqual(first.metadata, await repo.getSkill('shared'));
    assert.equal(first.metadata.sha256, '1'.repeat(64));
    assert.equal(first.metadata.name, 'First');
    assert.equal(Buffer.from(first.tarball).toString(), 'archive-one');
    assert.ok(!('tarball' in first.metadata));
    await repo.publish({ manifest: manifest('3'.repeat(64), 'Next'), tarball: Buffer.from('archive-next'), chunks: [] });
    const next = await repo.getMcpSkill('shared');
    assert.equal(next.metadata.sha256, '3'.repeat(64));
    assert.equal(next.metadata.name, 'Next');
    assert.equal(Buffer.from(next.tarball).toString(), 'archive-next');
    assert.equal(await repo.getMcpSkill('missing'), null);
    assert.equal((await other.getMcpSkill('shared')).metadata.name, 'Foreign');
    await other.publish({ manifest: { ...manifest('5'.repeat(64)), slug: 'foreign-only' }, tarball: Buffer.from('foreign-only'), chunks: [] });
    assert.equal(await repo.getMcpSkill('foreign-only'), null);
    await repo.publish({ manifest: { ...manifest('4'.repeat(64)), slug: 'no-archive', kind: 'plugin', plugin_slug: 'example@mkt' }, tarball: null, chunks: [] });
    const plugin = await repo.getMcpSkill('no-archive');
    assert.equal(plugin.metadata.kind, 'plugin');
    assert.equal(plugin.metadata.plugin_slug, 'example@mkt');
    assert.equal(plugin.metadata.sha256, '4'.repeat(64));
    assert.equal(plugin.tarball, null);
  } finally { await closePg(pg); }
});

const MAX_QUOTA_ATTEMPTS = 3;

// Retry only an observed DB clock boundary, never a failed quota assertion.
async function collectInSingleMinute(readMinute, runAttempt) {
  for (let attempt = 0; attempt < MAX_QUOTA_ATTEMPTS; attempt++) {
    const before = await readMinute();
    const result = await runAttempt(attempt);
    if (before === await readMinute()) return result;
  }
  assert.fail(`MCP quota test crossed a database minute in all ${MAX_QUOTA_ATTEMPTS} attempts`);
}

test('single-minute quota guard returns a stable attempt without retrying', async () => {
  const attempts = [];
  const result = { allowed: 'actual results are checked by the caller' };
  assert.equal(await collectInSingleMinute(async () => 'minute-1', async (attempt) => {
    attempts.push(attempt);
    return result;
  }), result);
  assert.deepEqual(attempts, [0]);
});

test('single-minute quota guard discards a crossing attempt and runs a fresh one', async () => {
  const minutes = ['minute-1', 'minute-2', 'minute-2', 'minute-2'];
  const attempts = [];
  const result = await collectInSingleMinute(async () => minutes.shift(), async (attempt) => {
    attempts.push(attempt);
    return { attempt };
  });
  assert.deepEqual(result, { attempt: 1 });
  assert.deepEqual(attempts, [0, 1]);
  assert.deepEqual(minutes, []);
});

test('single-minute quota guard fails clearly after three crossing attempts', async () => {
  const minutes = ['minute-1', 'minute-2', 'minute-2', 'minute-3', 'minute-3', 'minute-4'];
  const attempts = [];
  await assert.rejects(collectInSingleMinute(async () => minutes.shift(), async (attempt) => {
    attempts.push(attempt);
  }), { name: 'AssertionError', message: 'MCP quota test crossed a database minute in all 3 attempts' });
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(minutes, []);
});

// Catches owner leakage, process-local counters, an off-by-one allowance and non-atomic writes.
test('MCP search budget allows 60 calls per owner and minute, with a bounded retry and fresh windows', async () => {
  const { pg, db, other } = await fixture();
  try {
    const { owner, repo, results, windows } = await collectInSingleMinute(
      async () => (await pg.query("select date_trunc('minute', clock_timestamp())::text as minute")).rows[0].minute,
      async (attempt) => {
        const owner = await db.resolveOwner('user', `mcp-budget-${attempt}`);
        const repo = repoForOwner(db.withOwner, owner);
        const results = await Promise.all(Array.from({ length: 61 }, () => repo.consumeMcpSearchBudget()));
        const { rows: windows } = await pg.query('select used from app.mcp_search_budget where owner_id=$1', [owner]);
        return { owner, repo, results, windows };
      },
    );
    // One counter row also makes the previous-minute fixture update collision-free.
    assert.deepEqual(windows, [{ used: 61 }]);
    assert.equal(results.filter((r) => r.allowed).length, 60);
    assert.ok(results.slice(0, 60).every((r) => r.retryAfter === 0));
    assert.equal(results[60].allowed, false);
    assert.ok(Number.isInteger(results[60].retryAfter) && results[60].retryAfter >= 1 && results[60].retryAfter <= 60);
    assert.deepEqual(await other.consumeMcpSearchBudget(), { allowed: true, retryAfter: 0 });
    // A previous-minute fixture proves rollover without sleeping or overriding the production clock.
    await pg.query("update app.mcp_search_budget set window_start = date_trunc('minute', clock_timestamp()) - interval '1 minute' where owner_id=$1", [owner]);
    assert.deepEqual(await repo.consumeMcpSearchBudget(), { allowed: true, retryAfter: 0 });
    const { rows } = await pg.query('select used from app.mcp_search_budget where owner_id=$1 order by window_start', [owner]);
    assert.deepEqual(rows.map((r) => r.used), [61, 1]);
  } finally { await closePg(pg); }
});

const readDbMinute = (pg) => async () => (await pg.query("select date_trunc('minute', clock_timestamp())::text as minute")).rows[0].minute;

// Catches a budget table that grows forever, and a prune that touches another owner's counters.
test('consume prunes only the caller\'s expired windows', async () => {
  const { pg, owner, foreign, repo } = await fixture();
  try {
    const { a, b } = await collectInSingleMinute(readDbMinute(pg), async () => {
      await pg.query('delete from app.mcp_search_budget');
      await pg.query(`insert into app.mcp_search_budget(owner_id,window_start,used) values
        ($1,date_trunc('minute', clock_timestamp()) - interval '5 minutes',7),
        ($1,date_trunc('minute', clock_timestamp()) - interval '1 minute',9),
        ($2,date_trunc('minute', clock_timestamp()) - interval '5 minutes',11)`, [owner, foreign]);
      assert.deepEqual(await repo.consumeMcpSearchBudget(), { allowed: true, retryAfter: 0 });
      const q = (id) => pg.query(`select used, window_start = date_trunc('minute', clock_timestamp()) as current,
        window_start = date_trunc('minute', clock_timestamp()) - interval '1 minute' as previous
        from app.mcp_search_budget where owner_id=$1 order by window_start`, [id]);
      return { a: (await q(owner)).rows, b: (await q(foreign)).rows };
    });
    assert.deepEqual(a, [{ used: 9, current: false, previous: true }, { used: 1, current: true, previous: false }]);
    assert.deepEqual(b.map((r) => r.used), [11]);
  } finally { await closePg(pg); }
});

// Seeds the exact boundary (minute-2 is expired, minute-1 is kept) so an off-by-one bound cannot pass.
test('consume keeps exactly the previous and current windows per owner', async () => {
  const { pg, owner, repo } = await fixture();
  try {
    const rows = await collectInSingleMinute(readDbMinute(pg), async () => {
      await pg.query('delete from app.mcp_search_budget where owner_id=$1', [owner]);
      await pg.query(`insert into app.mcp_search_budget(owner_id,window_start,used) values
        ($1,date_trunc('minute', clock_timestamp()) - interval '3 minutes',3),
        ($1,date_trunc('minute', clock_timestamp()) - interval '2 minutes',2),
        ($1,date_trunc('minute', clock_timestamp()) - interval '1 minute',1)`, [owner]);
      await repo.consumeMcpSearchBudget();
      return (await pg.query(`select used, window_start = date_trunc('minute', clock_timestamp()) as current,
        window_start = date_trunc('minute', clock_timestamp()) - interval '1 minute' as previous
        from app.mcp_search_budget where owner_id=$1 order by window_start`, [owner])).rows;
    });
    assert.deepEqual(rows, [{ used: 1, current: false, previous: true }, { used: 1, current: true, previous: false }]);
  } finally { await closePg(pg); }
});

test('MCP budget requires owner context and app role can only execute consume, never read or mutate counters or prune', async () => {
  const { pg, pool, db, owner, repo } = await fixture();
  try {
    await assert.rejects(createRepo(pool).consumeMcpSearchBudget(), { code: '22023' });
    await pool.query("select set_config('app.owner_id', '', false)");
    await assert.rejects(createRepo(pool).consumeMcpSearchBudget(), { code: '22023' });
    await assert.rejects(db.withOwner(2147483647, (tx) => createRepo(tx).consumeMcpSearchBudget()), { code: '22023' });
    assert.deepEqual(await repo.consumeMcpSearchBudget(), { allowed: true, retryAfter: 0 });
    for (const sql of [
      'select * from app.mcp_search_budget',
      "insert into app.mcp_search_budget(owner_id,window_start,used) values ($1,clock_timestamp(),0)",
      'update app.mcp_search_budget set used=0 where owner_id=$1',
      'delete from app.mcp_search_budget where owner_id=$1',
      'select app.prune_mcp_search_budget()',
    ]) {
      await assert.rejects(db.withOwner(owner, (tx) => tx.query(sql, sql.includes('$1') ? [owner] : [])), { code: '42501' });
    }
    await pg.exec('create role mcp_budget_unprivileged; grant usage on schema app to mcp_budget_unprivileged');
    const unprivileged = appPool(pg, 'mcp_budget_unprivileged');
    await assert.rejects(unprivileged.query('select app.consume_mcp_search_budget()'), { code: '42501' });
    await assert.rejects(unprivileged.query('select app.prune_mcp_search_budget()'), { code: '42501' });
  } finally { await closePg(pg); }
});

test('only an operator prunes MCP windows older than two minutes and preserves recent rows', async () => {
  const { pg, owner } = await fixture();
  try {
    await pg.query(`insert into app.mcp_search_budget(owner_id,window_start,used) values
      ($1,date_trunc('minute', clock_timestamp()) - interval '3 minutes',60),
      ($1,date_trunc('minute', clock_timestamp()) - interval '1 minute',60),
      ($1,date_trunc('minute', clock_timestamp()),1)`, [owner]);
    await pg.query('select app.prune_mcp_search_budget()');
    const { rows } = await pg.query('select used from app.mcp_search_budget where owner_id=$1 order by window_start', [owner]);
    assert.deepEqual(rows.map((r) => r.used), [60, 1]);
  } finally { await closePg(pg); }
});

// Public baseline parity cannot see app tables: assert the actual migrated PostgreSQL catalog here.
test('MCP budget catalog has exact column types, composite primary key, owner FK and restricted definer functions', async () => {
  const { pg } = await fixture();
  try {
    const q = rowsOf(pg);
    const columns = await q(`select a.attname as name, format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as required
      from pg_attribute a where a.attrelid=to_regclass('app.mcp_search_budget') and a.attnum>0 and not a.attisdropped order by a.attnum`);
    assert.deepEqual(columns, [
      { name: 'owner_id', type: 'bigint', required: true },
      { name: 'window_start', type: 'timestamp with time zone', required: true },
      { name: 'used', type: 'integer', required: true },
    ]);
    const constraints = await q(`select contype,pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid='app.mcp_search_budget'::regclass and contype in ('f','p') order by contype`);
    assert.deepEqual(constraints, [
      { contype: 'f', definition: 'FOREIGN KEY (owner_id) REFERENCES owners(id)' },
      { contype: 'p', definition: 'PRIMARY KEY (owner_id, window_start)' },
    ]);
    assert.deepEqual(await q(`select n.nspname as schema,c.relname as table_name from pg_constraint k
      join pg_class c on c.oid=k.confrelid join pg_namespace n on n.oid=c.relnamespace
      where k.conrelid='app.mcp_search_budget'::regclass and k.contype='f'`), [{ schema: 'public', table_name: 'owners' }]);
    const functions = await q(`select proname,prosecdef,pronargs,proconfig from pg_proc where pronamespace='app'::regnamespace
      and proname in ('consume_mcp_search_budget','prune_mcp_search_budget') order by proname`);
    assert.deepEqual(functions, [
      { proname: 'consume_mcp_search_budget', prosecdef: true, pronargs: 0, proconfig: ['search_path=pg_catalog, pg_temp'] },
      { proname: 'prune_mcp_search_budget', prosecdef: true, pronargs: 0, proconfig: ['search_path=pg_catalog, pg_temp'] },
    ]);
    assert.deepEqual(await q(`select count(*)::int as public_grants from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.pronamespace='app'::regnamespace and p.proname in ('consume_mcp_search_budget','prune_mcp_search_budget') and acl.grantee=0`), [{ public_grants: 0 }]);
    assert.deepEqual(await q(`select count(*)::int as public_grants from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where c.oid='app.mcp_search_budget'::regclass and acl.grantee=0`), [{ public_grants: 0 }]);
  } finally { await closePg(pg); }
});

test('MCP migration adopts the app schema already present after 0006 and a second run has no pending work', async () => {
  const before = await newPg();
  try {
    // Stop at 0006 so the new table must genuinely be adopted by 0007.
    await migrateThrough(before, '0006_');
    assert.equal((await before.query("select to_regnamespace('app') is not null as exists")).rows[0].exists, true);
    assert.equal((await before.query("select to_regclass('app.mcp_search_budget') as table_name")).rows[0].table_name, null);
    const prior = (await before.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n;
    await migrateThrough(before, '0007_');
    assert.equal((await before.query("select to_regclass('app.mcp_search_budget')::text as table_name")).rows[0].table_name, 'app.mcp_search_budget');
    assert.equal((await before.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, prior + 1);
    await migrateThrough(before, '0007_');
    assert.equal((await before.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, prior + 1);
  } finally { await closePg(before); }
});
