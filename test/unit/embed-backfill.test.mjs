import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { guardLocal } from '../../cli/connect.mjs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localTest } from '../local-helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault, MIGRATIONS } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { ENRICHMENT_VERSION } from '../../lib/enrich-prompt.mjs';
import { loadVec } from '../../lib/local/vec.mjs';
import { pack } from '../../lib/tar.mjs';

const KEY = 'test-gateway-key';
const ES = 'Necesito revisar los cambios de este proyecto';
const queries = Array.from({ length: 8 }, (_, i) => `Necesito revisar el proyecto numero ${i}`);
const temp = () => mkdtemp(path.join(os.tmpdir(), 'headjack-backfill-'));
async function fixture() {
  const dir = await temp();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  const repo = createSqliteRepo(db);
  return { dir, db, repo };
}
async function add(f, slug, { body = 'Body\nwith original lines', tarball = null, kind = 'plugin', current = true } = {}) {
  const ids = await f.repo.publish({ manifest: { slug, name: slug, description: 'description', kind, tags: [], source: { kind: 'local' }, sha256: slug.padEnd(64, '0'), status: 'approved' }, tarball, chunks: [{ text: body }] });
  if (current) await f.repo.setSpanish(ids.skillId, ids.versionId, ES, ENRICHMENT_VERSION);
  return ids;
}
function gateway(calls, fail = () => false) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (fail(body)) throw new Error('sensitive error body');
    if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: JSON.stringify({ queries_es: queries }) } }] });
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0) })) });
  };
}
async function run(f, options = {}) {
  const { embedCommand } = await import('../../cli/embed-backfill.mjs');
  const logs = []; const calls = [];
  const code = await embedCommand({ dir: f.dir, env: { AI_GATEWAY_API_KEY: KEY }, log: s => logs.push(s), fetchImpl: gateway(calls), ...options });
  return { code, logs, calls };
}
localTest('CLI embed missing key is fixed exit 2 and creates nothing', async () => {
  const dir = await temp();
  const r = spawnSync(process.execPath, ['cli/headjack.mjs', 'embed'], { env: { ...process.env, HEADJACK_HOME: dir, HOME: dir, HEADJACK_MODE: 'local', AI_GATEWAY_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), 'embed: no AI Gateway key');
  assert.deepEqual(await readdir(dir), []);
});
localTest('zero chunks retain hosted Spanish and plugin body; second run skips', async () => {
  const f = await fixture();
  try {
    await add(f, 'plugin');
    const first = await run(f);
    assert.equal(first.code, 0);
    assert.deepEqual(first.logs, ['examined: 1, embedded: 1, skipped: 0, failed: 0']);
    assert.deepEqual(first.calls[0].input, ['Body\nwith original lines', ES]);
    assert.equal(f.db.prepare('select queries_es_text from skills').get().queries_es_text, ES);
    assert.deepEqual((await run(f)).logs, ['examined: 1, embedded: 0, skipped: 1, failed: 0']);
  } finally { f.db.close(); }
});
for (const mode of ['key', 'vec']) localTest(`${mode} preflight leaves pre-migration and absent vault untouched`, async () => {
  const dir = await temp();
  const { DatabaseSync } = await runtimeCheck();
  for (const existing of [false, true]) {
    if (existing) { const db = new DatabaseSync(path.join(dir, 'vault.db')); for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql); db.exec(`pragma user_version=${MIGRATIONS.length - 1}`); db.close(); }
    const before = existing ? await readFile(path.join(dir, 'vault.db')) : null;
    const r = await run({ dir }, mode === 'key' ? { env: {} } : { loadVec: () => false });
    assert.equal(r.code, 2); assert.equal(r.calls.length, 0);
    assert.deepEqual(r.logs, [mode === 'key' ? 'embed: no AI Gateway key' : 'embed: vec unavailable']);
    assert.deepEqual(await readdir(dir), existing ? ['vault.db'] : []);
    if (existing) assert.deepEqual(await readFile(path.join(dir, 'vault.db')), before);
  }
});
localTest('secret skips and gateway failure continues with content-only failure', async () => {
  const f = await fixture();
  try {
    await add(f, 'secret', { body: `before\0github_pat_${'a'.repeat(82)}` });
    await add(f, 'failed'); await add(f, 'next');
    const calls = [];
    const r = await run(f, { fetchImpl: gateway(calls, b => b.input?.[0] === 'Body\nwith original lines' && calls.length === 1) });
    assert.deepEqual(r.logs, ['examined: 3, embedded: 1, skipped: 1, failed: 1']);
    assert.equal(r.code, 1);
    assert.equal(calls.length, 2);
    assert.equal(f.db.prepare('select count(*) n from chunk_vecs where skill_id in (1,2)').get().n, 0);
    assert.equal(f.db.prepare("select count(*) n from chunks where skill_id in (1,2) and kind='content'").get().n, 2);
  } finally { f.db.close(); }
});
localTest('stale enrichment calls completion; query-only tarball reconstructs content', async () => {
  const f = await fixture();
  try {
    const tarball = pack([{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('---\nname: Example\ndescription: Tarball description\n---\n# Heading\nParagraph body') }]);
    const ids = await add(f, 'tarball', { tarball, kind: 'skill', current: false });
    f.db.prepare("insert into chunks(skill_id,version_id,text,kind) values(?,?,?,'query')").run(ids.skillId, ids.versionId, ES);
    const r = await run(f);
    assert.equal(r.code, 0); assert.equal(r.calls.length, 2);
    assert.deepEqual(r.calls[1].input.slice(0, 2), ['Example: Tarball description', 'Example — Heading: Paragraph body']);
    assert.equal(r.calls[1].dimensions, 1536);
    assert.equal(r.calls[1].model, 'openai/text-embedding-3-small');
  } finally { f.db.close(); }
});
localTest('version race writes nothing to newer current version', async () => {
  const f = await fixture();
  try {
    await add(f, 'race');
    const calls = [];
    const r = await run(f, { fetchImpl: async (...args) => { f.db.exec('update skills set current_version_id = null'); return gateway(calls)(...args); } });
    assert.deepEqual(r.logs, ['examined: 1, embedded: 0, skipped: 1, failed: 0']);
    assert.equal(f.db.prepare('select count(*) n from chunks').get().n, 0);
  } finally { f.db.close(); }
});

localTest('actual connection load failure rolls back its writes and leaves legacy bytes unchanged', async () => {
  const dir = await temp(); const { DatabaseSync } = await runtimeCheck();
  const db = new DatabaseSync(path.join(dir, 'vault.db'));
  for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql);
  db.exec(`pragma user_version=${MIGRATIONS.length - 1}`); db.close();
  const before = await readFile(path.join(dir, 'vault.db')); let loads = 0;
  const result = await run({ dir }, { loadVec: connection => {
    loads++;
    assert.equal(loadVec(connection), true);
    return loads === 1;
  } });
  assert.equal(loads, 2); assert.equal(result.code, 2); assert.equal(result.calls.length, 0);
  assert.deepEqual(await readFile(path.join(dir, 'vault.db')), before);
  assert.deepEqual(await readdir(dir), ['vault.db']);
});
localTest('successful preflight with absent vault does not bootstrap', async () => {
  const dir = path.join(await temp(), 'absent');
  const result = await run({ dir });
  assert.equal(result.code, 0);
  assert.deepEqual(result.logs, ['examined: 0, embedded: 0, skipped: 0, failed: 0']);
  await assert.rejects(readdir(dir), { code: 'ENOENT' });
});
localTest('mismatched query texts and a missing content vector are repaired', async () => {
  const f = await fixture();
  try {
    await add(f, 'repair'); await run(f);
    assert.equal(loadVec(f.db), true);
    f.db.exec("update chunks set text='mismatched' where kind='query'");
    assert.equal((await run(f)).calls.length, 1);
    const id = f.db.prepare("select id from chunks where kind='content'").get().id;
    f.db.prepare('delete from chunk_vecs where rowid=?').run(BigInt(id));
    assert.equal((await run(f)).calls.length, 1);
    assert.equal((await run(f)).calls.length, 0);
  } finally { f.db.close(); }
});
for (const location of ['name', 'hosted', 'generated', 'raw']) localTest(`${location} secrets are skipped before embedding`, async () => {
  const f = await fixture();
  const token = `github_pat_${'b'.repeat(82)}`;
  try {
    await add(f, 'privacy', { current: location !== 'generated' });
    if (location === 'name') f.db.prepare('update skills set name=?').run(token);
    if (location === 'hosted') f.db.prepare('update skills set queries_es_text=?').run(`text\0${token}`);
    if (location === 'raw') f.db.prepare('update skill_docs set body=?').run('a'.repeat(9000) + ' ' + token);
    const calls = [];
    const result = await run(f, { fetchImpl: location === 'generated' ? async (_, options) => {
      calls.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ queries_es: [`Use ${token}`, ...queries.slice(0, 2)] }) } }] });
    } : gateway(calls) });
    assert.deepEqual(result.logs, ['examined: 1, embedded: 0, skipped: 1, failed: 0']);
    assert.equal(calls.length, location === 'generated' ? 1 : 0);
    assert.equal(loadVec(f.db), true);
    assert.equal(f.db.prepare('select count(*) n from chunk_vecs').get().n, 0);
  } finally { f.db.close(); }
});
localTest('bad vector dimension fails atomically and stale vectors with rejected rows are removed', async () => {
  const f = await fixture();
  try {
    await add(f, 'broken'); await run(f); assert.equal(loadVec(f.db), true);
    f.db.exec('update skills set current_version_id=null');
    await add(f, 'dimension');
    const result = await run(f, { fetchImpl: async (_, options) => Response.json({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1] })) }) });
    assert.equal(result.code, 1);
    assert.equal(f.db.prepare('select count(*) n from chunk_vecs').get().n, 0);
  } finally { f.db.close(); }
});

localTest('failed embeddings preserve hosted Spanish and retry never regenerates it', async () => {
  const f = await fixture();
  try {
    await add(f, 'retry');
    const failed = await run(f, { fetchImpl: async () => { throw new Error('private'); } });
    assert.equal(failed.code, 1);
    assert.equal(f.db.prepare('select queries_es_text from skills').get().queries_es_text, ES);
    assert.equal(f.db.prepare('select enrichment_v from skills').get().enrichment_v, ENRICHMENT_VERSION);
    const retry = await run(f);
    assert.equal(retry.code, 0); assert.equal(retry.calls.length, 1);
    assert.deepEqual(retry.calls[0].input, ['Body\nwith original lines', ES]);
  } finally { f.db.close(); }
});
localTest('a Gateway failure after a version switch does not clear newer content or Spanish', async () => {
  const f = await fixture();
  try {
    await add(f, 'failure-race');
    const result = await run(f, { fetchImpl: async () => {
      f.db.exec('update skills set current_version_id=null');
      throw new Error('private');
    } });
    assert.equal(result.code, 1);
    assert.equal(f.db.prepare('select queries_es_text from skills').get().queries_es_text, ES);
    assert.equal(f.db.prepare('select count(*) n from chunks').get().n, 0);
  } finally { f.db.close(); }
});

localTest('transient write contention preserves vectors and the busy outcome', async () => {
  const f = await fixture();
  const busyTimeoutMs = 500;
  const lockDurationMs = busyTimeoutMs * 1.5;
  let lockReleased;
  try {
    await add(f, 'busy');
    await run(f);
    assert.equal(loadVec(f.db), true);
    f.db.exec("update chunks set text='incomplete query' where kind='query'");
    const snapshot = () => ({
      chunks: f.db.prepare('select * from chunks order by id').all(),
      vectors: f.db.prepare('select rowid, embedding, skill_id, version_id from chunk_vecs order by rowid').all(),
      spanish: f.db.prepare('select queries_es_text, enrichment_v from skills').all(),
    });
    const before = snapshot();
    assert.ok(before.vectors.length > 0);
    const logs = [];
    const calls = [];
    let outcome;
    try {
      outcome = await guardLocal(f.dir, () => run(f, {
        log: line => logs.push(line),
        loadVec: db => {
          const loaded = loadVec(db);
          db.exec(`pragma busy_timeout = ${busyTimeoutMs}`);
          return loaded;
        },
        fetchImpl: async (...args) => {
          // Independent thread releases the real write lock while DatabaseSync blocks this thread.
          const locker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(workerData.file);
            db.exec('BEGIN IMMEDIATE');
            parentPort.postMessage('locked');
            setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, workerData.duration);
          `, { eval: true, workerData: { file: path.join(f.dir, 'vault.db'), duration: lockDurationMs } });
          lockReleased = once(locker, 'exit');
          await once(locker, 'message');
          return gateway(calls)(...args);
        },
      }));
    } catch (error) { outcome = error; }
    assert.deepEqual(await lockReleased, [0]);
    assert.deepEqual(snapshot(), before, 'busy write must not replace chunks or delete existing vectors');
    assert.equal(outcome.status, 503);
    assert.equal(outcome.code, 'unavailable');
    assert.equal(outcome.message, 'vault is busy, try again');
    assert.equal(calls.length, 1);
    assert.deepEqual(logs, []);
  } finally {
    if (lockReleased) await lockReleased;
    f.db.close();
  }
});
