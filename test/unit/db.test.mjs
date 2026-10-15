import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createDb, appDatabaseUrl } from '../../lib/db.mjs';

// Fake pg Pool: connect() hands out one recording client; `respond(text, params)` answers or throws.
function fakePool(respond = () => []) {
  const calls = [];
  const released = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    return { rows: (await respond(text, params)) ?? [] };
  };
  const pool = {
    calls, released, connects: 0, query,
    async connect() { pool.connects += 1; return { query, release: (err) => released.push({ err }) }; },
  };
  return pool;
}
const texts = (pool) => pool.calls.map((c) => c.text.trim());
// Every client withOwner takes from the pool goes back exactly once.
const assertBalanced = (pool) => assert.equal(pool.connects, pool.released.length, 'one release per connect');

test('withOwner pins app.owner_id as the first statement of one transaction and commits', async () => {
  const pool = fakePool(() => [{ n: 1 }]);
  const out = await createDb(pool).withOwner(12, (db) => db.query('select 1 as n').then((r) => r.rows[0].n));
  assert.equal(out, 1);
  assert.deepEqual(texts(pool), ['begin', "select set_config('app.owner_id', $1, true)", 'select 1 as n', 'commit']);
  assert.deepEqual(pool.calls[1].params, ['12']);
  assert.deepEqual(pool.released, [{ err: undefined }]);
  assertBalanced(pool);
});

test('withOwner rolls back, releases cleanly and rethrows when fn fails', async () => {
  const pool = fakePool();
  const boom = new Error('boom');
  await assert.rejects(createDb(pool).withOwner(1, async () => { throw boom; }), (e) => e === boom);
  assert.equal(texts(pool).at(-1), 'rollback');
  assert.ok(!texts(pool).includes('commit'));
  assert.deepEqual(pool.released, [{ err: undefined }]);
  assertBalanced(pool);
});

test('withOwner keeps the original error and discards the client when rollback itself fails', async () => {
  const boom = Object.assign(new Error('insert failed'), { code: '08006' });
  const pool = fakePool((text) => {
    if (text === 'rollback') throw new Error('connection already closed');
    return [];
  });
  await assert.rejects(createDb(pool).withOwner(1, async () => { throw boom; }), (e) => e === boom);
  assert.equal(pool.released.length, 1);
  assert.ok(pool.released[0].err, 'release(err) with a truthy arg so pg discards the broken client');
  assertBalanced(pool);
});

test('withOwner rolls back, releases once and rethrows the commit error when commit fails', async () => {
  const commitError = new Error('could not serialize access');
  const pool = fakePool((text) => {
    if (text === 'commit') throw commitError;
    return [];
  });
  await assert.rejects(createDb(pool).withOwner(1, async () => 'ok'), (e) => e === commitError);
  assert.deepEqual(texts(pool).slice(-2), ['commit', 'rollback']);
  assert.deepEqual(pool.released, [{ err: undefined }]);
  assertBalanced(pool);
});

for (const [step, failing] of [['begin', 'begin'], ['set_config', "select set_config('app.owner_id', $1, true)"]]) {
  test(`withOwner never runs fn, rolls back and releases once when ${step} fails`, async () => {
    const setupError = new Error(`${failing} failed`);
    const pool = fakePool((text) => {
      if (text === failing) throw setupError;
      return [];
    });
    let ran = false;
    await assert.rejects(createDb(pool).withOwner(1, async () => { ran = true; }), (e) => e === setupError);
    assert.equal(ran, false);
    assert.equal(texts(pool).at(-1), 'rollback');
    assert.deepEqual(pool.released, [{ err: undefined }]);
    assertBalanced(pool);
  });
}

test('withOwner refuses anything but a positive integer owner id, before touching the pool', async () => {
  const pool = fakePool();
  for (const bad of [0, -1, 1.5, NaN, '1', null, undefined, 2 ** 53]) {
    await assert.rejects(createDb(pool).withOwner(bad, async () => 1), TypeError, String(bad));
  }
  assert.deepEqual(pool.calls, []);
  assert.equal(pool.connects, 0);
  assertBalanced(pool);
});

test('the handle passed to fn has query only and stops working once the transaction ends', async () => {
  const pool = fakePool();
  let leaked;
  await createDb(pool).withOwner(3, async (db) => { leaked = db; });
  assert.deepEqual(Object.keys(leaked), ['query']);
  await assert.rejects(leaked.query('select 1'), /transaction already finished/);
  assert.ok(!texts(pool).includes('select 1'));
  assertBalanced(pool);
});

for (const [outcome, fn] of [['commit', async () => 'ok'], ['rollback', async () => { throw new Error('boom'); }]]) {
  test(`a query issued after fn settles is refused while ${outcome} is still running`, async () => {
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    const pool = fakePool(async (text) => {
      if (text === outcome) await gate;
      return [];
    });
    let leaked;
    const run = createDb(pool).withOwner(3, (db) => { leaked = db; return fn(); });
    for (let i = 0; i < 100 && !texts(pool).includes(outcome); i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(texts(pool).includes(outcome), `${outcome} was issued`);
    await assert.rejects(leaked.query('select late'), /transaction already finished/);
    openGate();
    await run.catch(() => {});
    assert.ok(!texts(pool).includes('select late'), 'the late query never reached the client');
    assertBalanced(pool);
  });
}

test('resolveOwner and listOwnerIds call the SECURITY DEFINER functions and return numbers', async () => {
  const pool = fakePool((text) => (text.includes('resolve_owner') ? [{ id: '4' }] : [{ id: '1' }, { id: '4' }]));
  const db = createDb(pool);
  assert.equal(await db.resolveOwner('user', 'legacy:v1'), 4);
  assert.deepEqual(await db.listOwnerIds(), [1, 4]);
  assert.deepEqual(pool.calls[0].params, ['user', 'legacy:v1']);
  assert.match(pool.calls[0].text, /app\.resolve_owner\(\$1, \$2\)/);
  assert.match(pool.calls[1].text, /app\.list_owner_ids\(\)/);
});

test('appDatabaseUrl prefers DATABASE_URL_APP and insists it is the app role', () => {
  const url = 'postgresql://headjack_app:pw' + '@ep-x-pooler.example.tech/neondb?sslmode=require';
  assert.equal(appDatabaseUrl({ DATABASE_URL_APP: url, DATABASE_URL: 'postgresql://neondb_owner:secret' + '@h/db' }), url);
  assert.throws(() => appDatabaseUrl({ DATABASE_URL_APP: 'postgresql://neondb_owner:secret' + '@h/db' }), /must connect as headjack_app/);
});

test('appDatabaseUrl rejects a DATABASE_URL_APP that connects as the old role', () => {
  const old = [['skill', 'vault'].join(''), 'app'].join('_');
  assert.throws(() => appDatabaseUrl({ DATABASE_URL_APP: `postgresql://${old}:pw` + '@h/db' }), /must connect as headjack_app/);
});

test('appDatabaseUrl derives the app URL from the branch owner URL without keeping the owner credentials', () => {
  const out = appDatabaseUrl({
    DATABASE_URL: 'postgresql://neondb_owner:' + 'owner' + 'secret' + '@ep-x-pooler.c-12.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require',
    HEADJACK_APP_DB_PASSWORD: 'p@ss' + '/w:rd#1',
  });
  const u = new URL(out);
  assert.equal(u.username, 'headjack_app');
  assert.equal(decodeURIComponent(u.password), 'p@ss/w:rd#1');
  assert.equal(u.host, 'ep-x-pooler.c-12.us-east-1.aws.neon.tech');
  assert.equal(u.search, '?channel_binding=require&sslmode=require');
  assert.doesNotMatch(out, /ownersecret|neondb_owner/);
});

test('db url uses HEADJACK_APP_DB_PASSWORD', () => {
  const owner = 'postgresql://neondb_owner:' + 'owner' + 'secret' + '@h/db';
  const appPassword = 'app-' + 'secret';
  const u = new URL(appDatabaseUrl({ DATABASE_URL: owner, HEADJACK_APP_DB_PASSWORD: appPassword }));
  assert.equal(u.username, 'headjack_app');
  assert.equal(u.password, appPassword);
});

test('appDatabaseUrl never falls back to the owner URL', () => {
  assert.throws(() => appDatabaseUrl({ DATABASE_URL: 'postgresql://neondb_owner:secret' + '@h/db' }), /HEADJACK_APP_DB_PASSWORD/);
  assert.throws(() => appDatabaseUrl({}), /DATABASE_URL_APP/);
});

test('appDatabaseUrl rejects a malformed URL without echoing its password', () => {
  const sentinel = 'SENTINEL_PW_9f3k';
  const cases = [
    [{ DATABASE_URL_APP: 'postgresql://headjack_app:' + sentinel + '@host:bad/db' }, /DATABASE_URL_APP is not a valid URL/],
    [{ DATABASE_URL: 'postgresql://neondb_owner:' + sentinel + '@host:bad/db', HEADJACK_APP_DB_PASSWORD: 'x' }, /DATABASE_URL is not a valid URL/],
  ];
  for (const [env, message] of cases) {
    let err;
    try { appDatabaseUrl(env); } catch (e) { err = e; }
    assert.ok(err, 'throws');
    assert.match(err.message, message);
    assert.ok(!inspect(err, { depth: Infinity }).includes(sentinel), 'no password in the logged error');
  }
});
