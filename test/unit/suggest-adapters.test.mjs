import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { localTest, zeroPagesAfterFirst } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { UserError } from '../../lib/errors.mjs';
import { createApi } from '../../cli/api.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { MIGRATIONS, openVault, vaultFile } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { hostedSearch } from '../../lib/suggest-hosted.mjs';
import { localSearch } from '../../lib/suggest-local.mjs';
import { searchHybrid } from '../../lib/local/hybrid.mjs';
import { loadVec } from '../../lib/local/vec.mjs';
import { rankSkills } from '../../lib/search.mjs';
import { loadSuggestConfig } from '../../lib/suggest-config.mjs';
import { searchRows } from '../../lib/suggest-calibrate.mjs';
import { suggestDeps } from '../../cli/suggest-deps.mjs';

const URL_ = 'https://headjack.example.invalid';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fetch fake that records every request; `reply` decides the answer. It honors the request's abort signal like fetch.
function fakeFetch(reply) {
  const requests = [];
  const fetchImpl = (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve(reply(String(url), init)).then(resolve, reject);
    });
  };
  return { fetchImpl, requests };
}

const keyEnv = (extra = {}) => ({ HEADJACK_TOKEN: 'key-1', ...extra });
const credential = { kind: 'api-key', token: 'key-1', source: 'env' };

// ---- api.searchPost ----

test('searchPost posts to <url>/api/search with q in the JSON body, never in the URL', async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ results: [{ slug: 'a' }] }));
  const api = createApi({ url: URL_, credential, dir: '/unused', fetchImpl, env: {} });
  const results = await api.searchPost('deploy my vercel app', 5, { purpose: 'suggest', sessionId: 'abc-123' });
  assert.deepEqual(results, [{ slug: 'a' }]);
  assert.equal(requests[0].url, `${URL_}/api/search`);
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { q: 'deploy my vercel app', k: 5 });
  const h = requests[0].init.headers;
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['x-headjack-purpose'], 'suggest');
  assert.equal(h['x-headjack-session'], 'abc-123');
  assert.equal(h.authorization, 'Bearer key-1');
});

test('searchPost drops an invalid explicit session id and the ambient one with it', async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ results: [] }));
  const api = createApi({ url: URL_, credential, dir: '/unused', fetchImpl, env: { CLAUDE_CODE_SESSION_ID: 'ambient-1' } });
  await api.searchPost('a prompt long enough to search', 5, { purpose: 'suggest', sessionId: 'bad id/../' });
  assert.equal('x-headjack-session' in requests[0].init.headers, false);
  await api.searchPost('a prompt long enough to search', 5, { purpose: 'suggest' });
  assert.equal(requests[1].init.headers['x-headjack-session'], 'ambient-1');
});

test('searchPost rejects promptly when its signal aborts, even before the request is answered', async () => {
  const { fetchImpl } = fakeFetch(() => new Promise(() => {}));
  const api = createApi({ url: URL_, credential, dir: '/unused', fetchImpl, env: {} });
  const ctl = new AbortController();
  const started = Date.now();
  const pending = api.searchPost('a prompt long enough to search', 5, { purpose: 'suggest', signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(pending);
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(api.searchPost('x', 5, { purpose: 'suggest', signal: ctl.signal }));
});

// ---- hostedSearch ----

const hostedArgs = (over = {}) => ({
  env: keyEnv({ HEADJACK_URL: URL_ }), dir: '/unused', config: { suggest: { url: null } },
  query: 'deploy my vercel app', purpose: 'suggest', sessionId: 'sess-1', ...over,
});

test('hostedSearch returns the candidates and the variant of the results', async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ results: [{ slug: 'a', variant: 'hybrid-v1', review: 'approved' }, { slug: 'b' }] }));
  const out = await hostedSearch({ ...hostedArgs(), fetchImpl });
  assert.deepEqual(out.candidates.map((c) => c.slug), ['a', 'b']);
  assert.equal(out.variant, 'hybrid-v1');
  assert.equal(out.outcome, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${URL_}/api/search`);
  assert.equal(JSON.parse(requests[0].init.body).k, 5);
});

test('hostedSearch takes the URL from HEADJACK_URL, else config.suggest.url, whatever HEADJACK_MODE says', async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ results: [] }));
  await hostedSearch({ ...hostedArgs({ env: keyEnv({ HEADJACK_MODE: 'local' }), config: { suggest: { url: 'https://cfg.example.invalid' } } }), fetchImpl });
  assert.equal(requests[0].url, 'https://cfg.example.invalid/api/search');
  await hostedSearch({ ...hostedArgs({ env: keyEnv({ HEADJACK_URL: URL_, HEADJACK_MODE: 'local' }), config: { suggest: { url: 'https://cfg.example.invalid' } } }), fetchImpl });
  assert.equal(requests[1].url, `${URL_}/api/search`);
});

test('hostedSearch without any URL is skipped:no-url and sends nothing', async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ results: [] }));
  assert.deepEqual(await hostedSearch({ ...hostedArgs({ env: keyEnv(), config: { suggest: { url: null } } }), fetchImpl }), { outcome: 'skipped:no-url' });
  assert.deepEqual(await hostedSearch({ ...hostedArgs({ env: keyEnv({ HEADJACK_URL: '' }), config: {} }), fetchImpl }), { outcome: 'skipped:no-url' });
  assert.equal(requests.length, 0);
});

test('a server that answers POST with 404 or 405 is skipped:no-post, not a failure', async () => {
  for (const status of [404, 405]) {
    const { fetchImpl } = fakeFetch(() => json({ error: { code: 'nope', message: 'no' } }, status));
    assert.deepEqual(await hostedSearch({ ...hostedArgs(), fetchImpl }), { outcome: 'skipped:no-post' });
  }
});

test('5xx and network errors reject with failure: true; the prompt text is not in the message', async () => {
  const query = 'my secret prompt about deploying things';
  const five = fakeFetch(() => json({ error: { code: 'down', message: 'unavailable' } }, 503));
  const err = await hostedSearch({ ...hostedArgs({ query }), fetchImpl: five.fetchImpl }).then(() => null, (e) => e);
  assert.equal(err.failure, true);
  assert.equal(err.status, 503);
  assert.ok(!err.message.includes('secret'));

  const net = fakeFetch(() => { throw new TypeError('fetch failed'); });
  const err2 = await hostedSearch({ ...hostedArgs({ query }), fetchImpl: net.fetchImpl }).then(() => null, (e) => e);
  assert.equal(err2.failure, true);
});

test('401, 403 and other 4xx reject with failure: false (the user can fix them; the breaker ignores them)', async () => {
  for (const status of [400, 401, 403, 429]) {
    const { fetchImpl } = fakeFetch(() => json({ error: { code: 'x', message: 'no' } }, status));
    const err = await hostedSearch({ ...hostedArgs(), fetchImpl }).then(() => null, (e) => e);
    assert.equal(err.status, status);
    assert.equal(err.failure, false, String(status));
  }
});

test('a missing credential rejects with failure: false', async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ results: [] }));
  const dir = await tempDir('sv-hosted-');
  const err = await hostedSearch({ ...hostedArgs({ env: { HEADJACK_URL: URL_ }, dir }), fetchImpl }).then(() => null, (e) => e);
  assert.match(err.message, /not logged in/);
  assert.equal(err.failure, false);
  assert.equal(requests.length, 0);
});

test('a bad suggest.url is a usage error naming suggest.url, not HEADJACK_URL', async () => {
  const { fetchImpl, requests } = fakeFetch(() => json({ results: [] }));
  for (const bad of ['http://example.invalid', 'not a url', 'https://u:p@example.invalid']) {
    const err = await hostedSearch({ ...hostedArgs({ env: keyEnv(), config: { suggest: { url: bad } } }), fetchImpl }).then(() => null, (e) => e);
    assert.ok(err instanceof UserError, bad);
    assert.match(err.message, /suggest\.url/);
    assert.doesNotMatch(err.message, /HEADJACK_URL/);
    assert.equal(err.failure, false);
  }
  const env = await hostedSearch({ ...hostedArgs({ env: keyEnv({ HEADJACK_URL: 'http://example.invalid' }) }), fetchImpl }).then(() => null, (e) => e);
  assert.match(env.message, /HEADJACK_URL/);
  assert.equal(requests.length, 0);
});

test('an answer over 256 KB is refused unparsed, as a failure', async () => {
  const big = JSON.stringify({ results: [{ slug: 'a', description: 'x'.repeat(300 * 1024) }] });
  const { fetchImpl } = fakeFetch(() => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }));
  const err = await hostedSearch({ ...hostedArgs(), fetchImpl }).then(() => null, (e) => e);
  assert.equal(err.code, 'too_large');
  assert.equal(err.failure, true);
});

test('an aborted signal rejects hostedSearch promptly with failure: true (a deadline timeout)', async () => {
  const { fetchImpl } = fakeFetch(() => new Promise(() => {}));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  const started = Date.now();
  const err = await hostedSearch({ ...hostedArgs({ signal: ctl.signal }), fetchImpl }).then(() => null, (e) => e);
  assert.ok(err);
  assert.equal(err.failure, true);
  assert.ok(Date.now() - started < 1000);
});

// ---- localSearch ----

let sha = 0;
const skill = (slug, description, body) => ({
  manifest: {
    slug, name: slug, description, kind: 'skill', plugin_slug: null, tags: [], source: { kind: 'local' },
    sha256: String((sha += 1)).padStart(64, '0'), status: 'approved', review_notes: 'ok', scan_flags: [],
  },
  tarball: null,
  chunks: [{ text: body, kind: 'content' }],
});

async function seededVault() {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-local-adapter-');
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  await repo.publish(skill('deploy-cron', 'Schedule deploy cron jobs', 'Runs a deploy on a cron schedule.'));
  await repo.publish(skill('gardening', 'Grow tomatoes', 'Water daily.'));
  db.close();
  return dir;
}

localTest('localSearch on a missing vault is skipped:no-vault and creates nothing, even with migrate', async () => {
  const dir = path.join(await tempDir('sv-local-adapter-'), 'state');
  for (const migrate of [false, true]) {
    assert.deepEqual(await localSearch({ dir, query: 'deploy cron jobs', migrate }), { outcome: 'skipped:no-vault' });
    assert.equal(existsSync(dir), false);
  }
  const empty = await tempDir('sv-local-adapter-');
  assert.deepEqual(await localSearch({ dir: empty, query: 'deploy cron jobs', migrate: true }), { outcome: 'skipped:no-vault' });
  assert.equal(existsSync(path.join(empty, 'vault.db')), false);
});

localTest('localSearch returns the signals of the current vault, variant local', async () => {
  const dir = await seededVault();
  const out = await localSearch({ dir, query: 'deploy cron jobs', migrate: false });
  assert.equal(out.outcome, undefined);
  assert.equal(out.variant, 'local');
  assert.deepEqual(out.candidates.map((c) => c.slug), ['deploy-cron']);
  assert.equal(out.candidates[0].table_rank, 1);
  assert.equal(out.candidates[0].review, 'approved');
  assert.deepEqual(await localSearch({ dir, query: 'a ! ?', migrate: false }), { candidates: [], variant: 'local', fallback: null });
});

localTest('localSearch ranks the Spanish example requests first for a Spanish query, and searches only the English text otherwise', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-local-adapter-');
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  // 'video-maker' wins the English table for "video render"; 'clip-render' wins the Spanish one.
  await repo.publish(skill('video-maker', 'Make a video', 'video video render video'));
  const clip = await repo.publish(skill('clip-render', 'Clip tools', 'Trims clips.'));
  await repo.setSpanish(clip.skillId, clip.versionId, 'renderizar el video final', 1);
  db.close();
  const es = await localSearch({ dir, query: 'necesito renderizar el video final', migrate: false });
  assert.deepEqual(es.candidates.slice(0, 2).map((c) => [c.slug, c.fts_table, c.table_rank]), [['clip-render', 'es', 1], ['video-maker', 'en', 1]]);
  const en = await localSearch({ dir, query: 'render the video please', migrate: false });
  assert.equal(en.candidates[0].slug, 'video-maker');
  assert.equal(en.candidates[0].fts_table, 'en');
  // An English prompt never searches the Spanish example requests: words that only they hold find nothing.
  assert.deepEqual((await localSearch({ dir, query: 'renderizar final today', migrate: false })).candidates, []);
});

localTest('an old schema is skipped:schema without migrate, migrated and searched with migrate', async () => {
  const dir = await seededVault();
  MIGRATIONS.push('create table adapter_future_probe (x integer)');
  try {
    assert.deepEqual(await localSearch({ dir, query: 'deploy cron jobs', migrate: false }), { outcome: 'skipped:schema' });
    const out = await localSearch({ dir, query: 'deploy cron jobs', migrate: true });
    assert.deepEqual(out.candidates.map((c) => c.slug), ['deploy-cron']);
    // Migrated for good: the read-only path now accepts the vault.
    assert.deepEqual((await localSearch({ dir, query: 'deploy cron jobs', migrate: false })).candidates.map((c) => c.slug), ['deploy-cron']);
  } finally {
    MIGRATIONS.pop();
  }
});

localTest('a locked vault is skipped:busy', async () => {
  const dir = await seededVault();
  const { DatabaseSync } = await runtimeCheck();
  // A WAL vault never blocks a reader, so leave WAL and hold an exclusive transaction: the read-only open then waits out
  // its busy timeout.
  const holder = new DatabaseSync(path.join(dir, 'vault.db'));
  holder.exec('PRAGMA journal_mode = DELETE');
  holder.exec('BEGIN EXCLUSIVE');
  try {
    assert.deepEqual(await localSearch({ dir, query: 'deploy cron jobs', migrate: false }), { outcome: 'skipped:busy' });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
});

localTest('localSearch never touches the network, whatever HEADJACK_URL and HEADJACK_MODE say', async (t) => {
  const dir = await seededVault();
  const saved = { fetch: globalThis.fetch, url: process.env.HEADJACK_URL, mode: process.env.HEADJACK_MODE };
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('network is off limits'); };
  process.env.HEADJACK_URL = URL_;
  process.env.HEADJACK_MODE = 'remote';
  t.after(() => {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [['HEADJACK_URL', saved.url], ['HEADJACK_MODE', saved.mode]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const out = await localSearch({ dir, query: 'deploy cron jobs', migrate: true });
  assert.deepEqual(out.candidates.map((c) => c.slug), ['deploy-cron']);
  assert.equal(calls, 0);
});

localTest('damage found during the search is a UserError with the damaged-vault message', async () => {
  const dir = await seededVault();
  await zeroPagesAfterFirst(vaultFile(dir));
  const err = await localSearch({ dir, query: 'deploy cron jobs', migrate: false }).then(() => null, (e) => e);
  assert.ok(err instanceof UserError);
  assert.equal(err.message, `vault ${vaultFile(dir)} is damaged; run headjack verify`);
});

localTest('a vault.db that is not a database is a UserError with the damaged-vault message, with and without migrate', async () => {
  const dir = await tempDir('sv-local-adapter-');
  const junk = Buffer.from('these are my notes, not a database\n'.repeat(40));
  await fsp.writeFile(vaultFile(dir), junk);
  for (const migrate of [false, true]) {
    const err = await localSearch({ dir, query: 'deploy cron jobs', migrate }).then(() => null, (e) => e);
    assert.ok(err instanceof UserError, `migrate ${migrate}`);
    assert.equal(err.message, `vault ${vaultFile(dir)} is damaged; run headjack verify`);
  }
  assert.deepEqual(await fsp.readFile(vaultFile(dir)), junk);
});

localTest('localSearch matches a Spanish prompt through example requests and, failing that, the glossary', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-local-adapter-');
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  await repo.publish(skill('deploy-cron', 'Schedule deploy cron jobs', 'Runs a deploy on a cron schedule.'));
  const gardening = await repo.publish(skill('gardening', 'Grow tomatoes', 'Water daily.'));
  await repo.setSpanish(gardening.skillId, gardening.versionId, 'cultivar tomates en casa', 1);
  db.close();
  // Through the Spanish example requests of an enriched skill.
  const es = await localSearch({ dir, query: 'quiero cultivar tomates', migrate: false });
  assert.deepEqual(es.candidates.map((c) => [c.slug, c.fts_table, c.table_rank]), [['gardening', 'es', 1]]);
  // Through the glossary, for a skill with no Spanish text of its own.
  const gloss = await localSearch({ dir, query: 'quiero desplegar un proceso', migrate: false });
  assert.deepEqual(gloss.candidates.map((c) => [c.slug, c.fts_table]), [['deploy-cron', 'en-gloss']]);
  // An English prompt never reaches the glossary table.
  assert.deepEqual((await localSearch({ dir, query: 'desplegar', migrate: false })).candidates, []);
});

// ---- embedder, allow-list and fallback plumbing ----

const vector = (x = 1, y = 0) => [x, y, ...Array(1534).fill(0)];
const QUERY = 'deploy recurring cron jobs';

// A writable vault whose chunks carry vectors: skill 1 (cron-top) matches the query text and sits on chunk 1, skill 2
// (vector-neighbor) matches only by vector and sits on chunk 2.
async function vecVault() {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-plumbing-');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  assert.equal(loadVec(db), true, 'vendored sqlite-vec must load');
  for (const [id, slug, body, embedding] of [
    [1, 'cron-top', 'deploy recurring cron jobs', vector(0, 1)],
    [2, 'vector-neighbor', 'garden tomatoes', vector()],
  ]) {
    db.prepare('insert into skills (id, slug, name, description, kind, tags) values (?, ?, ?, ?, ?, ?)').run(id, slug, slug, body, 'skill', '[]');
    db.prepare("insert into versions (id, skill_id, sha256, status, reviewed_at, review_notes) values (?, ?, ?, 'approved', '2020-01-01', 'ok')").run(id, id, `plumb${id}`);
    db.prepare('update skills set current_version_id = ? where id = ?').run(id, id);
    db.prepare("insert into skill_docs (rowid, name, description, tags, body) values (?, '', '', '', ?)").run(id, body);
    db.prepare('insert into chunk_vecs (rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)').run(BigInt(id), JSON.stringify(embedding), BigInt(id), BigInt(id));
  }
  db.close();
  return dir;
}

// Silences the fixed diagnostics the hybrid path prints, and restores console.error and HEADJACK_VEC_PATH afterwards.
function quiet(t, vecPath) {
  const saved = { error: console.error, vec: process.env.HEADJACK_VEC_PATH };
  console.error = () => {};
  if (vecPath !== undefined) process.env.HEADJACK_VEC_PATH = vecPath;
  t.after(() => {
    console.error = saved.error;
    if (saved.vec === undefined) delete process.env.HEADJACK_VEC_PATH; else process.env.HEADJACK_VEC_PATH = saved.vec;
  });
}

localTest('a given embed and chunkIds reach searchVector', async (t) => {
  quiet(t);
  const dir = await vecVault();
  // End to end through localSearch: the given embed stands in for the key (none exists), the allow-list drops chunk 1.
  const texts = [];
  const embed = async (input) => { texts.push(input); return [vector()]; };
  const out = await localSearch({ dir, query: QUERY, hybrid: true, env: {}, embed, searchOptions: { chunkIds: new Set([2]) }, fetchImpl: () => assert.fail('must not fetch') });
  assert.deepEqual(texts, [[QUERY]]);
  assert.equal(out.fallback, null);
  const bySlug = new Map(out.candidates.map((c) => [c.slug, c]));
  assert.equal(bySlug.get('cron-top').vector_rank, null);
  assert.equal(bySlug.get('vector-neighbor').vector_rank, 1);
  // The same query without the allow-list ranks both chunks.
  const open = await localSearch({ dir, query: QUERY, hybrid: true, env: {}, embed });
  assert.notEqual(new Map(open.candidates.map((c) => [c.slug, c])).get('cron-top').vector_rank, null);
  // The arguments the repo sees: the vector, the candidate pool, the tags, then the options object itself.
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    const calls = [];
    const real = createSqliteRepo(db);
    const repo = { ...real, searchVector: async (...args) => { calls.push(args); return real.searchVector(...args); } };
    const searchOptions = { chunkIds: new Set([1]) };
    await searchHybrid({ db, repo, query: QUERY, embed, limit: 5, tags: [], searchOptions });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), [vector(), 50, []]);
    assert.equal(calls[0][3], searchOptions);
  } finally { db.close(); }
});

test('rankSkills hands searchOptions to searchVector as the fourth argument', async () => {
  const calls = [];
  const repo = {
    searchVector: async (...args) => { calls.push(args); return []; },
    searchText: async () => [],
    getSkillsByIds: async () => [],
  };
  const searchOptions = { chunkIds: new Set([7]) };
  await rankSkills({ repo, embed: async () => [vector()], query: QUERY, tags: ['t'], k: 5, searchOptions });
  assert.equal(calls[0].length, 4);
  assert.equal(calls[0][3], searchOptions);
  calls.length = 0;
  await rankSkills({ repo, embed: async () => [vector()], query: QUERY, tags: ['t'], k: 5 });
  assert.equal(calls[0][3], undefined);
});

localTest('a missing vec library gives fallback vec-unavailable on the searchRows row', async (t) => {
  const dir = await vecVault();
  quiet(t, '/no-such-headjack-vec'); // after the fixture: building it needs the real extension
  const base = await loadSuggestConfig(await tempDir('sv-plumbing-cfg-'));
  const config = { ...base, suggest: { ...base.suggest, enabled: true } };
  const ctx = { env: {}, dir, home: dir, cwd: dir };
  const embed = async () => assert.fail('must not embed without the extension');
  const out = await searchRows([{ q: QUERY, slug: 'cron-top', lang: 'en' }], {
    mode: 'local', config, cwd: dir, home: dir, depsFor: () => suggestDeps({ ctx, config, hybrid: true, embed, searchOptions: {} }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].fallback, 'vec-unavailable');
  assert.equal(out[0].record.candidates[0].slug, 'cron-top');
});

localTest('a searchVector throw gives vec-unavailable and busy still rethrows', async (t) => {
  quiet(t);
  const dir = await vecVault();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    const real = createSqliteRepo(db);
    const reasons = [];
    const broken = { ...real, searchVector: async () => { throw new Error('vector query unavailable'); } };
    const rows = await searchHybrid({ db, repo: broken, query: QUERY, embed: async () => [vector()], limit: 5, tags: [], onFallback: (r) => reasons.push(r) });
    assert.equal(Array.isArray(rows), true);
    assert.equal(rows[0].slug, 'cron-top');
    assert.equal(rows[0].vector_rank, null);
    assert.deepEqual(reasons, ['vec-unavailable']);
    for (const errcode of [5, 11]) {
      const error = Object.assign(new Error('database failure'), { code: 'ERR_SQLITE_ERROR', errcode });
      const seen = [];
      const repo = { ...real, searchVector: async () => { throw error; } };
      await assert.rejects(searchHybrid({ db, repo, query: QUERY, embed: async () => [vector()], limit: 5, tags: [], onFallback: (r) => seen.push(r) }), (e) => e === error);
      assert.deepEqual(seen, []);
    }
  } finally { db.close(); }
});

localTest('a secret in the query gives fallback secret and full-text candidates', async (t) => {
  quiet(t);
  const dir = await vecVault();
  const secret = 'ghp_' + 'A'.repeat(36); // synthetic, never a usable credential
  let embedded = 0;
  const out = await localSearch({ dir, query: `${QUERY} ${secret}`, hybrid: true, env: {}, embed: async () => { embedded += 1; return [vector()]; } });
  assert.equal(embedded, 0);
  assert.equal(out.fallback, 'secret');
  assert.equal(out.variant, 'local');
  assert.equal(out.candidates[0].slug, 'cron-top');
  assert.equal(out.candidates[0].vector_rank, null);
  assert.equal(out.candidates[0].similarity, null);
});

localTest('an embed failure gives embed-failed', async (t) => {
  quiet(t);
  const dir = await vecVault();
  const out = await localSearch({ dir, query: QUERY, hybrid: true, env: {}, embed: async () => { throw new Error('private query'); } });
  assert.equal(out.fallback, 'embed-failed');
  assert.equal(out.candidates[0].slug, 'cron-top');
  assert.equal(out.candidates[0].vector_rank, null);
});

localTest('no key and no embed gives no-key when hybrid is true', async (t) => {
  quiet(t);
  const dir = await vecVault();
  const out = await localSearch({ dir, query: QUERY, hybrid: true, env: {}, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(out.fallback, 'no-key');
  assert.equal(out.candidates[0].slug, 'cron-top');
  assert.equal(out.candidates[0].vector_rank, null);
  // A call carrying searchOptions never looks up a key itself, even when one exists.
  let fetched = 0;
  const keyed = await localSearch({
    dir, query: QUERY, hybrid: true, env: { AI_GATEWAY_API_KEY: 'test-fixture' }, searchOptions: {},
    fetchImpl: async () => { fetched += 1; return Response.json({}); },
  });
  assert.equal(keyed.fallback, 'no-key');
  assert.equal(fetched, 0);
});

localTest('hybrid false never reports a fallback, with or without a key', async (t) => {
  quiet(t);
  const dir = await vecVault();
  for (const env of [{}, { AI_GATEWAY_API_KEY: 'test-fixture' }]) {
    const out = await localSearch({
      dir, query: QUERY, hybrid: false, env, embed: async () => assert.fail('must not embed'), fetchImpl: () => assert.fail('must not fetch'),
    });
    assert.equal(out.fallback, null);
    assert.equal(out.variant, 'local');
    assert.equal(out.candidates[0].slug, 'cron-top');
  }
  assert.equal((await localSearch({ dir, query: QUERY })).fallback, null);
});

localTest('onFallback is called at most once per search', async (t) => {
  quiet(t);
  const dir = await vecVault();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    const repo = createSqliteRepo(db);
    const reasons = [];
    const onFallback = (r) => reasons.push(r);
    // A secret ends in full text once; an embed failure once; a searchVector throw (called twice by one search) once.
    await searchHybrid({ db, repo, query: `${QUERY} ghp_${'A'.repeat(36)}`, embed: async () => [vector()], limit: 5, tags: [], onFallback });
    assert.deepEqual(reasons.splice(0), ['secret']);
    await searchHybrid({ db, repo, query: QUERY, embed: async () => { throw new Error('x'); }, limit: 5, tags: [], onFallback });
    assert.deepEqual(reasons.splice(0), ['embed-failed']);
    let thrown = 0;
    const broken = { ...repo, searchVector: async () => { thrown += 1; throw new Error('vector query unavailable'); } };
    // Two reads of the vector branch in one search, as a caller that retries through the same wrapper would make.
    await searchHybrid({
      db, repo: broken, query: QUERY, embed: async () => [vector()], limit: 5, tags: [], onFallback,
      readSnapshot: async (read) => { await read(); return read(); },
    });
    assert.equal(thrown, 2);
    assert.deepEqual(reasons.splice(0), ['vec-unavailable']);
  } finally { db.close(); }
});

localTest('searchHybrid called without a callback returns the same array as before', async (t) => {
  quiet(t);
  const dir = await vecVault();
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    const repo = createSqliteRepo(db);
    const embed = async () => [vector()];
    const plain = await searchHybrid({ db, repo, query: QUERY, embed, limit: 5, tags: [] });
    assert.equal(Array.isArray(plain), true);
    const withCallback = await searchHybrid({ db, repo, query: QUERY, embed, limit: 5, tags: [], searchOptions: undefined, onFallback: () => {} });
    assert.deepEqual(withCallback, plain);
    assert.deepEqual(plain.map((r) => r.slug).sort(), ['cron-top', 'vector-neighbor']);
    // Every fallback path still returns an array with no callback.
    for (const failing of [async () => { throw new Error('x'); }, undefined]) {
      assert.equal(Array.isArray(await searchHybrid({ db, repo, query: QUERY, embed: failing, limit: 5, tags: [] })), true);
    }
    assert.equal(Array.isArray(await searchHybrid({ db, repo, query: `${QUERY} ghp_${'A'.repeat(36)}`, embed, limit: 5, tags: [] })), true);
  } finally { db.close(); }
});
