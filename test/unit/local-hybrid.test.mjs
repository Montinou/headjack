import assert from 'node:assert/strict';
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
