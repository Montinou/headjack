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
  assert.deepEqual(await localSearch({ dir, query: 'a ! ?', migrate: false }), { candidates: [], variant: 'local' });
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
