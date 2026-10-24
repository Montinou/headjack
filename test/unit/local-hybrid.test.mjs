import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localSupported, localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault, vaultFile } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { loadVec } from '../../lib/local/vec.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};
const vector = (x = 1, y = 0) => [x, y, ...Array(1534).fill(0)];
async function fixture() {
  const db = openVault({ dir: await tempDir('sv-hybrid-'), DatabaseSync, allowExtension: true });
  assert.equal(loadVec(db), true, 'vendored sqlite-vec must load');
  for (const [id, kind, tags, current] of [[1, 'skill', ['wanted'], 1], [2, 'skill', [], 2], [3, 'skill', ['wanted'], null], [4, 'plugin', ['wanted'], 4]]) {
    db.prepare('insert into skills (id, slug, name, description, kind, tags) values (?, ?, ?, ?, ?, ?)').run(id, `s${id}`, `Skill ${id}`, 'kilnstone', kind, JSON.stringify(tags));
    db.prepare("insert into versions (id, skill_id, sha256, status, reviewed_at) values (?, ?, ?, ?, '2020-01-01')").run(id, id, `sha${id}`, current ? 'approved' : 'rejected');
    if (current) db.prepare('update skills set current_version_id = ? where id = ?').run(current, id);
    db.prepare("insert into skill_docs (rowid, name, description, tags, body) values (?, '', '', '', 'kilnstone')").run(id);
    db.prepare('insert into chunk_vecs (rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)').run(BigInt(id), JSON.stringify(vector(1, id === 3 ? 0 : id)), BigInt(id), BigInt(id));
  }
  return db;
}
localTest('searchVector cleans rejected/null-current rows, filters tags, uses cosine and best hit per skill', async () => {
  const db = await fixture();
  try {
    db.prepare('insert into chunk_vecs (rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)').run(5n, JSON.stringify(vector()), 1n, 1n);
    const repo = createSqliteRepo(db);
    const hits = await repo.searchVector(vector(), 1, ['wanted']);
    assert.deepEqual(hits, [{ id: 1, sim: 1 }]);
    assert.equal(db.prepare('select count(*) n from chunk_vecs where version_id = 3').get().n, 0);
    assert.deepEqual((await repo.searchVector(vector(), 10, ['wanted'])).map(r => r.id), [1, 4]);
    const unfiltered = await repo.searchVector(vector(), 10, []);
    assert.equal(unfiltered.filter(r => r.id === 1).length, 1);
    assert.ok(Math.abs(unfiltered.find(r => r.id === 2).sim - 1 / Math.sqrt(5)) < 0.00001);
  } finally { db.close(); }
});
localTest('KNN binds BigInt post-cleanup count capped at 4096, not candidate limit', async () => {
  for (const count of [0, 75, 5000]) {
    const calls = [];
    const db = {
      enableLoadExtension() {}, loadExtension() {}, exec() {},
      prepare(sql) {
        return {
          get() { return { n: sql.includes('sqlite_master') ? 1 : count }; },
          run() { calls.push({ sql }); },
          all(...params) { calls.push({ sql, params }); return []; },
        };
      },
    };
    await createSqliteRepo(db).searchVector(vector(), 50, []);
    const knn = calls.find(c => c.sql.includes('embedding match'));
    if (count === 0) assert.equal(knn, undefined);
    else assert.equal(knn.params[1], BigInt(Math.min(4096, count)));
    assert.equal(calls[0].sql, 'delete from chunk_vecs where not exists (select 1 from skills s where s.current_version_id = chunk_vecs.version_id)');
  }
});
localTest('hybrid embeds once and forwards kind; embedding failure logs only fixed text and returns FTS', async () => {
  const db = await fixture();
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const { searchHybrid } = await import('../../lib/local/hybrid.mjs');
    const repo = createSqliteRepo(db);
    let calls = 0;
    const rows = await searchHybrid({ db, repo, query: 'kilnstone', embed: async texts => { calls++; assert.deepEqual(texts, ['kilnstone']); return [vector()]; }, limit: 10, tags: ['wanted'], kind: 'skill' });
    assert.equal(calls, 1);
    assert.deepEqual(rows.map(r => r.slug), ['s1']);
    assert.equal(rows[0].matched, 'both');
    const fallback = await searchHybrid({ db, repo, query: 'kilnstone private query', embed: async () => { throw Error('private query'); }, limit: 10, tags: ['wanted'], kind: 'skill' });
    assert.equal(fallback[0].matched, 'fts');
    assert.equal(fallback[0].vector_rank, null);
    assert.equal(fallback[0].similarity, null);
    assert.deepEqual(logged, [['query embedding failed']]);
  } finally { console.error = original; db.close(); }
});
localTest('unavailable vec falls back without embedding or touching vectors', async () => {
  const db = await fixture();
  const previous = process.env.HEADJACK_VEC_PATH;
  process.env.HEADJACK_VEC_PATH = '/no-such-headjack-vec';
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const { searchHybrid } = await import('../../lib/local/hybrid.mjs');
    const rows = await searchHybrid({ db, repo: createSqliteRepo(db), query: 'kilnstone', embed: async () => { assert.fail('must not embed'); }, limit: 10, tags: ['wanted'] });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.matched === 'fts' && r.vector_rank === null && r.similarity === null));
    assert.equal(db.prepare('select count(*) n from chunk_vecs').get().n, 4);
    assert.deepEqual(logged, [['vec unavailable']]);
  } finally { console.error = original; if (previous === undefined) delete process.env.HEADJACK_VEC_PATH; else process.env.HEADJACK_VEC_PATH = previous; db.close(); }
});

localTest('cleanup through candidate selection excludes a concurrent publisher and releases its lock', async () => {
  const dir = await tempDir('sv-hybrid-race-');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  const publisher = new DatabaseSync(vaultFile(dir));
  publisher.exec('PRAGMA busy_timeout = 0');
  assert.equal(loadVec(db), true);
  try {
    db.exec("insert into skills (id, slug, name, description, kind, tags) values (1, 'race', 'Race', 'race', 'skill', '[]'); insert into versions (id, skill_id, sha256, status, reviewed_at) values (1, 1, 'old', 'approved', '2020-01-01'), (2, 1, 'new', 'approved', '2020-01-01'); update skills set current_version_id = 1 where id = 1");
    db.prepare('insert into chunk_vecs (rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)').run(1n, JSON.stringify(vector()), 1n, 1n);
    let publishError;
    let attempted = false;
    const wrapped = new Proxy(db, {
      get(target, key) {
        if (key === 'prepare') return sql => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('delete from chunk_vecs where not exists')) return statement;
          return { run(...args) {
            const result = statement.run(...args);
            attempted = true;
            try { publisher.exec('update skills set current_version_id = 2 where id = 1'); }
            catch (error) { publishError = error; }
            return result;
          } };
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.deepEqual(await createSqliteRepo(wrapped).searchVector(vector(), 10), [{ id: 1, sim: 1 }]);
    assert.equal(attempted, true);
    assert.equal(publishError?.errcode, 5, 'publisher must be busy until candidate selection commits');
    assert.equal(db.isTransaction, false);
    publisher.exec('update skills set current_version_id = 2 where id = 1');
    assert.deepEqual(await createSqliteRepo(db).searchVector(vector(), 10), []);
    assert.equal(db.prepare('select count(*) n from chunk_vecs').get().n, 0);
    publisher.exec('BEGIN IMMEDIATE');
    db.exec('PRAGMA busy_timeout = 0');
    await assert.rejects(createSqliteRepo(db).searchVector(vector(), 10), error => error.errcode === 5);
    assert.equal(db.isTransaction, false);
    publisher.exec('ROLLBACK');
  } finally { if (publisher.isTransaction) publisher.exec('ROLLBACK'); publisher.close(); db.close(); }
});

// T7 exercises callers over a real writable vault; Gateway responses stay in-process.
async function callerFixture() {
  const dir = await tempDir('sv-hybrid-callers-');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  assert.equal(loadVec(db), true);
  for (const [id, slug, body, kind, tags, embedding] of [
    [1, 'cron-top', 'deploy recurring cron jobs', 'skill', ['wanted'], vector(0, 1)],
    [2, 'vector-neighbor', 'garden tomatoes', 'skill', [], vector()],
    [3, 'plugin-neighbor', 'garden vegetables', 'plugin', ['wanted'], vector(1, 1)],
  ]) {
    db.prepare('insert into skills (id, slug, name, description, kind, tags) values (?, ?, ?, ?, ?, ?)').run(id, slug, slug, body, kind, JSON.stringify(tags));
    db.prepare("insert into versions (id, skill_id, sha256, status, reviewed_at, review_notes) values (?, ?, ?, 'approved', '2020-01-01', 'ok')").run(id, id, `caller${id}`);
    db.prepare('update skills set current_version_id = ? where id = ?').run(id, id);
    db.prepare("insert into skill_docs (rowid, name, description, tags, body) values (?, '', '', '', ?)").run(id, body);
    db.prepare('insert into chunk_vecs (rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)').run(BigInt(id), JSON.stringify(embedding), BigInt(id), BigInt(id));
  }
  db.close();
  return dir;
}
const gateway = calls => async (_url, init) => {
  calls.push(JSON.parse(init.body));
  return Response.json({ data: [{ index: 0, embedding: vector() }] });
};
localTest('local route fuses GET/POST results, honors kind and tags, and falls back on failed embeddings', async () => {
  const { createLocalApi } = await import('../../lib/local/api.mjs');
  const dir = await callerFixture();
  const calls = [];
  const local = await createLocalApi({ dir, env: { AI_GATEWAY_API_KEY: 'test-fixture' }, fetchImpl: gateway(calls) });
  try {
    for (const init of [undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'noexactmatch', k: 5, kind: 'plugin', tags: ['wanted'] }) }]) {
      const response = await local.route('http://headjack.local/api/search?q=noexactmatch&k=5&kind=plugin&tag=wanted', init);
      assert.equal(response.status, 200);
      const { results } = await response.json();
      assert.deepEqual(results.map(r => r.slug), ['plugin-neighbor']);
      assert.equal(results[0].vector_rank, 1);
      assert.equal(results[0].fts_rank, null);
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].input, ['noexactmatch']);
  } finally { local.close(); }
  const failed = await createLocalApi({ dir, env: { AI_GATEWAY_API_KEY: 'test-fixture' }, fetchImpl: async () => { throw Error('private query'); } });
  try {
    const response = await failed.route('http://headjack.local/api/search?q=deploy%20recurring%20cron%20jobs');
    assert.equal(response.status, 200);
    const { results } = await response.json();
    assert.equal(results[0].slug, 'cron-top');
    assert.equal(results[0].vector_rank, null);
  } finally { failed.close(); }
});
localTest('manual hybrid keeps the full-text offer and appends rejected vector explain neighbors', async () => {
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const { passes } = await import('../../lib/suggest-rule.mjs');
  const dir = await callerFixture();
  const calls = [];
  const args = { dir, query: 'deploy recurring cron jobs', env: { AI_GATEWAY_API_KEY: 'test-fixture' }, fetchImpl: gateway(calls) };
  const before = await localSearch(args);
  const after = await localSearch({ ...args, hybrid: true });
  assert.deepEqual(after.candidates.filter(c => passes(c, 'local').pass).map(c => c.slug), before.candidates.filter(c => passes(c, 'local').pass).map(c => c.slug));
  assert.deepEqual(before.candidates.map(c => c.slug), ['cron-top']);
  const neighbor = after.candidates.find(c => c.slug === 'vector-neighbor');
  assert.ok(neighbor, 'vector-only row must remain visible for explain');
  assert.equal(neighbor.table_rank, null);
  assert.equal(neighbor.vector_rank, 1);
  assert.equal(passes(neighbor, 'local').pass, false);
  assert.equal(after.candidates[0].table_rank, 1);
  assert.equal(after.candidates[0].vector_rank, 3);
  assert.equal(calls.length, 1);
});
localTest('suggestDeps forwards hybrid and env to localSearch for manual/eval and false for hooks', async () => {
  const { suggestDeps } = await import('../../cli/suggest-deps.mjs');
  const calls = [];
  const ctx = { dir: await tempDir('sv-hybrid-deps-'), env: {}, home: '/unused', cwd: '/unused' };
  for (const hybrid of [true, false]) {
    await suggestDeps({ ctx, config: {}, hybrid, adapters: { localSearch: async args => { calls.push(args); return []; } } }).search('cron', 'local');
    assert.equal(calls.at(-1).hybrid, hybrid);
    assert.equal(calls.at(-1).env, ctx.env);
  }
});
localTest('local caller keyless and missing-extension fallbacks never fetch and preserve full text', async () => {
  const { createLocalApi } = await import('../../lib/local/api.mjs');
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const dir = await callerFixture();
  const previous = process.env.HEADJACK_VEC_PATH;
  let fetched = 0;
  const noFetch = async () => { fetched++; throw Error('fallback must not fetch'); };
  try {
    for (const env of [{}, { AI_GATEWAY_API_KEY: 'test-fixture' }]) {
      if (env.AI_GATEWAY_API_KEY) process.env.HEADJACK_VEC_PATH = '/missing-t7-vec';
      const local = await createLocalApi({ dir, env, fetchImpl: noFetch });
      try {
        for (const [url, init] of [
          ['http://headjack.local/api/search?q=cron&k=0'],
          ['http://headjack.local/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'cron', kind: 'invalid' }) }],
        ]) assert.equal((await local.route(url, init)).status, 400);
        const response = await local.route('http://headjack.local/api/search?q=deploy%20recurring%20cron%20jobs');
        const { results } = await response.json();
        assert.equal(results[0].slug, 'cron-top');
        assert.equal(results[0].vector_rank, null);
      } finally { local.close(); }
      const result = await localSearch({ dir, query: 'deploy recurring cron jobs', hybrid: true, env, fetchImpl: noFetch });
      assert.equal(result.candidates[0].slug, 'cron-top');
      assert.equal(result.candidates[0].vector_rank, null);
      assert.equal(fetched, 0, 'fallback must not fetch');
    }
  } finally { if (previous === undefined) delete process.env.HEADJACK_VEC_PATH; else process.env.HEADJACK_VEC_PATH = previous; }
});

localTest('manual CLI explain displays vector neighbor while offering only the text winner', async () => {
  const dir = await callerFixture();
  const preload = `globalThis.fetch = async () => Response.json({ data: [{ index: 0, embedding: [1, ...Array(1535).fill(0)] }] });`;
  const cli = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, cli, 'suggest', 'deploy recurring cron jobs', '--explain'], {
    env: { PATH: process.env.PATH, HOME: dir, HEADJACK_HOME: dir, AI_GATEWAY_API_KEY: 'test-fixture' }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const [offer, explanation] = child.stdout.split('candidates:');
  assert.match(offer, /cron-top/);
  assert.doesNotMatch(offer, /vector-neighbor/);
  assert.match(explanation, /vector-neighbor.*vector_rank=1.*table_rank=.*passed=false rejected_by=not-top/);
});
localTest('manual embedding failure retains full-text signals and makes just one request', async () => {
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const dir = await callerFixture();
  let calls = 0;
  const found = await localSearch({ dir, query: 'deploy recurring cron jobs', hybrid: true, env: { AI_GATEWAY_API_KEY: 'test-fixture' }, fetchImpl: async () => { calls++; throw Error('private'); } });
  assert.equal(calls, 1);
  assert.equal(found.candidates[0].slug, 'cron-top');
  assert.equal(found.candidates[0].table_rank, 1);
  assert.equal(found.candidates[0].vector_rank, null);
  assert.equal(found.candidates[0].similarity, null);
});

// Phase 3 review regressions: real SQLite and in-process Gateway fixtures only.
localTest('F1 vector cleanup/count/KNN failures return filtered full text with null vector fields', async () => {
  const { searchHybrid } = await import('../../lib/local/hybrid.mjs');
  for (const fragment of ['delete from chunk_vecs where not exists', 'select count(*) as n from chunk_vecs', 'embedding match']) {
    const db = await fixture();
    let injected = false;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return sql => {
        if (sql.includes(fragment)) { injected = true; throw Error('vector query unavailable'); }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      const rows = await searchHybrid({ db: wrapped, repo: createSqliteRepo(wrapped), query: 'kilnstone', embed: async () => [vector()], limit: 1, tags: ['wanted'], kind: 'skill' });
      assert.equal(injected, true);
      assert.deepEqual(rows.map(r => r.slug), ['s1']);
      assert.ok(rows.every(r => r.vector_rank === null && r.similarity === null && r.matched === 'fts'));
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare('select count(*) n from chunk_vecs').get().n, 4, 'failed vector cleanup rolls back');
    } finally { db.close(); }
  }
});

localTest('F1 vector busy and damaged errors retain their classification', async () => {
  const { searchHybrid } = await import('../../lib/local/hybrid.mjs');
  const db = await fixture();
  try {
    for (const errcode of [5, 11, 26]) {
      const error = Object.assign(Error('database failure'), { code: 'ERR_SQLITE_ERROR', errcode });
      const repo = { ...createSqliteRepo(db), searchVector: async () => { throw error; } };
      await assert.rejects(searchHybrid({ db, repo, query: 'kilnstone', embed: async () => [vector()], limit: 5, tags: [] }), e => e === error);
    }
  } finally { db.close(); }
});

localTest('F2 hybrid newer-schema vault skips with and without a key or migration', async () => {
  const { MIGRATIONS } = await import('../../lib/local/schema.mjs');
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const dir = await callerFixture();
  const db = new DatabaseSync(vaultFile(dir));
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  db.close();
  let fetched = 0;
  for (const migrate of [false, true]) {
    for (const env of [{}, { AI_GATEWAY_API_KEY: 'test-fixture' }]) {
      const result = await localSearch({ dir, query: 'cron', hybrid: true, migrate, env, fetchImpl: async () => { fetched++; return Response.json({}); } });
      assert.deepEqual(result, { outcome: 'skipped:schema' });
    }
  }
  assert.equal(fetched, 0);
});

localTest('F3 recognized query secrets including NUL-separated text never reach the Gateway or diagnostics', async () => {
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const dir = await callerFixture();
  const secret = 'ghp_' + 'A'.repeat(36); // synthetic, never a usable credential
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  let fetched = 0;
  try {
    for (const separator of [' ', '\0']) {
      const result = await localSearch({ dir, query: `deploy recurring cron jobs${separator}${secret}`, hybrid: true, env: { AI_GATEWAY_API_KEY: 'test-fixture' }, fetchImpl: async () => { fetched++; return Response.json({ data: [{ index: 0, embedding: vector() }] }); } });
      assert.equal(result.candidates[0].slug, 'cron-top');
      assert.equal(fetched, 0, 'recognized secret must stay local');
      assert.equal(result.candidates[0].vector_rank, null);
      assert.equal(result.candidates[0].similarity, null);
    }
    assert.ok(!JSON.stringify(logged).includes(secret));
  } finally { console.error = original; }
});

localTest('F4 replacement during embedding refreshes offer signals and metadata to the current version', async () => {
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const { passes } = await import('../../lib/suggest-rule.mjs');
  const { publishCurrent } = await import('../../lib/local/publish-current.mjs');
  for (const body of ['gardening tomatoes', 'deploy recurring cron jobs']) {
    const dir = await callerFixture();
    const publisher = openVault({ dir, DatabaseSync, allowExtension: true });
    publisher.exec('PRAGMA busy_timeout = 0');
    try {
      const result = await localSearch({ dir, query: 'deploy recurring cron jobs', hybrid: true, env: { AI_GATEWAY_API_KEY: 'test-fixture' }, fetchImpl: async () => {
        await publishCurrent({ db: publisher, repo: createSqliteRepo(publisher), manifest: { slug: 'cron-top', name: 'Replacement', description: body, kind: 'skill', tags: ['replacement'], sha256: 'replacement', status: 'approved', review_notes: 'ok' }, chunks: [body] });
        return Response.json({ data: [{ index: 0, embedding: vector() }] });
      } });
      const current = await localSearch({ dir, query: 'deploy recurring cron jobs' });
      const offered = result.candidates.filter(c => passes(c, 'local').pass);
      assert.deepEqual(offered.map(c => c.slug), current.candidates.filter(c => passes(c, 'local').pass).map(c => c.slug));
      const candidate = result.candidates.find(c => c.slug === 'cron-top');
      if (body === 'gardening tomatoes') assert.equal(candidate, undefined, 'obsolete version must not remain eligible or visible');
      else {
        assert.equal(candidate.name, 'Replacement');
        assert.equal(candidate.description, body);
        assert.deepEqual(candidate.tags, ['replacement']);
        assert.equal(candidate.vector_rank, null, 'replacement must not inherit old vectors');
      }
    } finally { publisher.close(); }
  }
});

localTest('F4 decision signals and fused metadata share a snapshot after embedding', async () => {
  const { localSearch } = await import('../../lib/suggest-local.mjs');
  const dir = await callerFixture();
  const publisher = openVault({ dir, DatabaseSync });
  publisher.exec('PRAGMA busy_timeout = 0');
  let attempted = false;
  let publishError;
  let reader;
  const CheckedDatabase = function(file, options) {
    const db = new DatabaseSync(file, options);
    reader = db;
    return new Proxy(db, { get(target, key) {
      if (key === 'prepare') return sql => {
        const statement = target.prepare(sql);
        if (!sql.includes('s.description, s.kind, s.tags, v.review_notes')) return statement;
        return { all(...args) {
          const rows = statement.all(...args);
          attempted = true;
          try { publisher.exec("update skills set name = 'Incoherent', description = 'changed' where id = 1"); }
          catch (error) { publishError = error; }
          return rows;
        } };
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    let outsideTransaction = false;
    const result = await localSearch({ dir, DatabaseSync: CheckedDatabase, query: 'deploy recurring cron jobs', hybrid: true, env: { AI_GATEWAY_API_KEY: 'test-fixture' }, fetchImpl: async () => {
      outsideTransaction = !reader.isTransaction;
      return Response.json({ data: [{ index: 0, embedding: vector() }] });
    } });
    assert.equal(outsideTransaction, true, 'Gateway must run outside a transaction');
    assert.equal(attempted, true);
    assert.equal(publishError?.errcode, 5, 'publisher cannot change versions between decision and fused reads');
    assert.equal(result.candidates[0].name, 'cron-top');
    assert.equal(result.candidates[0].description, 'deploy recurring cron jobs');
    publisher.exec("update skills set name = 'After read' where id = 1");
  } finally { publisher.close(); }
});
