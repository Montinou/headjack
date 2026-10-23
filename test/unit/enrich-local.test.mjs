// Opt-in local Spanish enrichment: nothing leaves the machine unless enrich.enabled is true and a key is present, the
// secret scan runs on the exact payload, and neither the key nor prompt/response text is ever logged. No test makes a
// network call: every request goes through an injected fetchImpl.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { localTest } from '../local-helpers.mjs';
import { tempDir, captureLog } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { UserError } from '../../lib/errors.mjs';
import { ENRICHMENT_VERSION, ENRICH_ES_JSON_SCHEMA, SYSTEM_ES, buildPrompt } from '../../lib/enrich-prompt.mjs';
import { aiGatewayKey, enrichAfterImport, enrichCommand, enrichLocal, GATEWAY_URL, REQUEST_TIMEOUT_MS } from '../../cli/enrich-local.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const KEY = 'gw-test-key-0123456789';
const ON = { enrich: { enabled: true, model: 'openai/gpt-5-mini' } };
const OFF = { enrich: { enabled: false, model: 'openai/gpt-5-mini' } };

let sha = 0;
function version(slug, { body = `${slug} body text`, description = `${slug} description`, name = slug } = {}) {
  sha += 1;
  return {
    manifest: {
      slug, name, description, kind: 'skill', plugin_slug: null, tags: [], source: { kind: 'local' },
      sha256: String(sha).padStart(64, '0'), status: 'approved', review_notes: 'ok', scan_flags: [],
    },
    tarball: null,
    chunks: [{ text: body, kind: 'content' }],
  };
}

async function fixture(skills = ['alpha', 'beta']) {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-enrich-');
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  const ids = {};
  for (const s of skills) {
    const spec = typeof s === 'string' ? { slug: s } : s;
    ids[spec.slug] = await repo.publish(version(spec.slug, spec));
  }
  return { db, repo, dir, ids, close: () => db.close() };
}

// The gateway answer of the T23 probe: the JSON text sits at choices[0].message.content, as a string.
const answer = (queries) => Response.json({
  id: 'gen-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ queries_es: queries }) } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
const QUERIES = ['¿Puedes mezclar estas pistas de audio?', 'Necesito ajustar el volumen de mi grabación', 'Ayúdame a limpiar el ruido del micrófono'];

function recorder(respond = () => answer(QUERIES)) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls.at(-1), calls.length);
  };
  fn.calls = calls;
  return fn;
}

const run = (f, extra = {}) => enrichLocal({
  repo: f.repo, stale: false, config: ON, env: { AI_GATEWAY_API_KEY: KEY }, dir: f.dir, log: captureLog(), ...extra,
});

// ---- aiGatewayKey ----

test('aiGatewayKey: the environment wins, trimmed; an empty one falls back to the file', async () => {
  const dir = await tempDir('sv-key-');
  assert.equal(await aiGatewayKey({ env: { AI_GATEWAY_API_KEY: `  ${KEY}\n` }, dir }), KEY);
  assert.equal(await aiGatewayKey({ env: {}, dir }), null);
  assert.equal(await aiGatewayKey({ env: { AI_GATEWAY_API_KEY: '  ' }, dir }), null);
  await fsp.writeFile(path.join(dir, 'ai-gateway-key'), `file-key\n`, { mode: 0o600 });
  await fsp.chmod(path.join(dir, 'ai-gateway-key'), 0o600);
  assert.equal(await aiGatewayKey({ env: {}, dir }), 'file-key');
  assert.equal(await aiGatewayKey({ env: { AI_GATEWAY_API_KEY: KEY }, dir }), KEY);
});

test('aiGatewayKey: a key file that is not exactly mode 0600 is refused, naming the file and never the key', async () => {
  const dir = await tempDir('sv-key-');
  const file = path.join(dir, 'ai-gateway-key');
  await fsp.writeFile(file, `${KEY}\n`);
  for (const mode of [0o644, 0o640, 0o400, 0o700, 0o666]) {
    await fsp.chmod(file, mode);
    await assert.rejects(aiGatewayKey({ env: {}, dir }), (e) => e instanceof UserError && e.message.includes(file) && !e.message.includes(KEY), mode.toString(8));
  }
});

test('aiGatewayKey: a symlink is refused (even to a 0600 file), naming the file', async () => {
  const dir = await tempDir('sv-key-');
  const real = path.join(dir, 'real-key');
  await fsp.writeFile(real, `${KEY}\n`, { mode: 0o600 });
  await fsp.chmod(real, 0o600);
  const link = path.join(dir, 'ai-gateway-key');
  await fsp.symlink(real, link);
  await assert.rejects(aiGatewayKey({ env: {}, dir }), (e) => e instanceof UserError && e.message.includes(link) && e.message.includes('symlink') && !e.message.includes(KEY));
  // A dangling link is refused the same way, not treated as "no key".
  await fsp.rm(real);
  await assert.rejects(aiGatewayKey({ env: {}, dir }), (e) => e instanceof UserError && e.message.includes(link));
});

test('aiGatewayKey: a FIFO is refused without hanging', async (t) => {
  const dir = await tempDir('sv-key-');
  const fifo = path.join(dir, 'ai-gateway-key');
  try {
    await promisify(execFile)('mkfifo', [fifo]);
  } catch {
    t.skip('mkfifo is not available');
    return;
  }
  await fsp.chmod(fifo, 0o600); // the mode is right: the refusal is for the file type
  const outcome = await Promise.race([
    aiGatewayKey({ env: {}, dir }).then(() => 'resolved', (e) => e),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 5000).unref()),
  ]);
  assert.notEqual(outcome, 'hung', 'opening a FIFO must not block');
  assert.ok(outcome instanceof UserError && outcome.message.includes(fifo), String(outcome));
});

// ---- enrichLocal ----

localTest('success: one request per skill in the T23 shape, the cleaned queries joined by spaces, enrichment_v = the version', async () => {
  const f = await fixture();
  try {
    const fetchImpl = recorder();
    const log = captureLog();
    const result = await run(f, { fetchImpl, log });
    assert.deepEqual(result, { enriched: ['alpha', 'beta'], skipped: [], failed: [] });
    assert.equal(fetchImpl.calls.length, 2);

    const [first] = fetchImpl.calls;
    assert.equal(first.url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
    assert.equal(GATEWAY_URL, first.url);
    assert.equal(first.init.method, 'POST');
    assert.deepEqual(first.init.headers, { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    assert.ok(first.init.signal instanceof AbortSignal, 'every request has a timeout signal');
    assert.equal(REQUEST_TIMEOUT_MS, 30000);
    // Only the skill payload leaves: the model, the fixed system text and the prompt built from name/description/body.
    assert.deepEqual(Object.keys(first.body).sort(), ['messages', 'model', 'response_format']);
    assert.equal(first.body.model, 'openai/gpt-5-mini');
    const { prompt } = buildPrompt({ name: 'alpha', description: 'alpha description', body: 'alpha body text' }, { spanishOnly: true });
    assert.deepEqual(first.body.messages, [{ role: 'system', content: SYSTEM_ES }, { role: 'user', content: prompt }]);
    assert.deepEqual(first.body.response_format, {
      type: 'json_schema',
      json_schema: { name: 'enrich_es', strict: true, schema: { ...ENRICH_ES_JSON_SCHEMA, additionalProperties: false } },
    });

    for (const slug of ['alpha', 'beta']) {
      const skill = await f.repo.getSkill(slug);
      assert.equal(skill.queries_es_text, QUERIES.join(' '));
      assert.equal(skill.enrichment_v, ENRICHMENT_VERSION);
      assert.equal(skill.enrichment_v, 1);
    }
    // The Spanish table is searchable now.
    const hit = f.db.prepare('select rowid as id from skill_docs_es where skill_docs_es match ?').all('"mezclar"');
    assert.equal(hit.length, 2);
    // Logs carry slugs and counts only: no key, no prompt text, no response text.
    const logged = log.text();
    for (const secret of [KEY, 'alpha body text', 'alpha description', QUERIES[0], 'Skill name:']) assert.ok(!logged.includes(secret), secret);
    assert.match(logged, /alpha/);
  } finally { f.close(); }
});

localTest('the configured model is the one sent', async () => {
  const f = await fixture(['alpha']);
  try {
    const fetchImpl = recorder();
    await run(f, { fetchImpl, config: { enrich: { enabled: true, model: 'acme/other-model' } } });
    assert.equal(fetchImpl.calls[0].body.model, 'acme/other-model');
  } finally { f.close(); }
});

localTest('enrich.enabled false: one notice, nothing sent, nothing stored, even with a key', async () => {
  const f = await fixture();
  try {
    const fetchImpl = recorder();
    const log = captureLog();
    const result = await run(f, { fetchImpl, log, config: OFF });
    assert.deepEqual(result, { enriched: [], skipped: [], failed: [] });
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(log.lines, ['enrich is off: set enrich.enabled to true in config.json to send skill text to the AI Gateway']);
    assert.equal((await f.repo.getSkill('alpha')).enrichment_v, null);
  } finally { f.close(); }
});

localTest('no key: one notice, nothing sent, enrichment_v stays null', async () => {
  const f = await fixture();
  try {
    const fetchImpl = recorder();
    const log = captureLog();
    const result = await run(f, { fetchImpl, log, env: {} });
    assert.deepEqual(result, { enriched: [], skipped: [], failed: [] });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /no AI Gateway key/);
    assert.match(log.lines[0], /AI_GATEWAY_API_KEY/);
    assert.equal((await f.repo.getSkill('alpha')).enrichment_v, null);
  } finally { f.close(); }
});

localTest('a key file that is not 0600 makes enrichLocal throw a UserError naming it, and nothing is sent', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.dir, 'ai-gateway-key');
    await fsp.writeFile(file, `${KEY}\n`);
    await fsp.chmod(file, 0o644);
    const fetchImpl = recorder();
    await assert.rejects(run(f, { fetchImpl, env: {} }), (e) => e instanceof UserError && e.message.includes(file));
    assert.equal(fetchImpl.calls.length, 0);
  } finally { f.close(); }
});

localTest('the secret scan covers name, description and body (and a NUL cannot hide one): the skill is skipped and never sent', async () => {
  const aws = `${'AK' + 'IA'}${'B'.repeat(16)}`;
  const f = await fixture([
    { slug: 'in-body', body: `Use the account.\nkey = ${aws}\n` },
    { slug: 'in-description', description: `Deploys with ${aws}` },
    { slug: 'in-name', name: `token ${aws}` },
    { slug: 'hidden', body: `\u0000binary-looking start\nkey = ${aws}\n` },
    { slug: 'clean' },
  ]);
  try {
    const fetchImpl = recorder();
    const log = captureLog();
    const result = await run(f, { fetchImpl, log });
    assert.deepEqual(result.enriched, ['clean']);
    assert.deepEqual(result.skipped, ['in-body', 'in-description', 'in-name', 'hidden'].map((slug) => ({ slug, reason: 'secret-scan flagged aws-access-key' })));
    assert.deepEqual(result.failed, []);
    assert.equal(fetchImpl.calls.length, 1, 'only the clean skill was sent');
    assert.ok(!JSON.stringify(fetchImpl.calls).includes(aws));
    assert.ok(!log.text().includes(aws));
    assert.match(log.text(), /skipped in-body: secret-scan flagged aws-access-key/);
    for (const slug of ['in-body', 'in-description', 'in-name', 'hidden']) assert.equal((await f.repo.getSkill(slug)).enrichment_v, null, slug);
  } finally { f.close(); }
});

localTest('a secret past the body clip is never sent and does not flag the skill', async () => {
  const aws = `${'AK' + 'IA'}${'C'.repeat(16)}`;
  const f = await fixture([{ slug: 'long', body: `${'x '.repeat(3200)}\n${aws}\n` }]);
  try {
    const fetchImpl = recorder();
    const result = await run(f, { fetchImpl });
    assert.deepEqual(result.enriched, ['long']);
    assert.ok(!fetchImpl.calls[0].init.body.includes(aws), 'the scanned text is the text that is sent: the clip applies to both');
  } finally { f.close(); }
});

localTest('--stale selects only null or older enrichment_v; without it the default is skills with no Spanish text', async () => {
  const f = await fixture(['empty', 'older', 'current']);
  try {
    await f.repo.setSpanish(f.ids.older.skillId, f.ids.older.versionId, 'texto viejo', 0);
    await f.repo.setSpanish(f.ids.current.skillId, f.ids.current.versionId, 'texto vigente', ENRICHMENT_VERSION);
    const stale = recorder();
    assert.deepEqual((await run(f, { fetchImpl: stale, stale: true })).enriched, ['empty', 'older']);
    assert.equal((await f.repo.getSkill('current')).queries_es_text, 'texto vigente');

    const g = await fixture(['empty', 'older', 'current']);
    try {
      await g.repo.setSpanish(g.ids.older.skillId, g.ids.older.versionId, 'texto viejo', 0);
      await g.repo.setSpanish(g.ids.current.skillId, g.ids.current.versionId, 'texto vigente', ENRICHMENT_VERSION);
      assert.deepEqual((await run(g, { fetchImpl: recorder() })).enriched, ['empty']);
    } finally { g.close(); }
  } finally { f.close(); }
});

localTest('explicit slugs enrich those skills only; an unknown slug is reported as skipped', async () => {
  const f = await fixture(['alpha', 'beta', 'gamma']);
  try {
    const fetchImpl = recorder();
    const result = await run(f, { fetchImpl, slugs: ['gamma', 'nope', 'gamma'] });
    assert.deepEqual(result.enriched, ['gamma']);
    assert.deepEqual(result.skipped, [{ slug: 'nope', reason: 'nothing to enrich (unknown slug or already current)' }]);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal((await f.repo.getSkill('alpha')).enrichment_v, null);
  } finally { f.close(); }
});

localTest('one failure is reported with a safe reason and the others are still enriched', async () => {
  const f = await fixture(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  try {
    const leak = 'RESPONSE-TEXT-THAT-MUST-NOT-BE-LOGGED';
    const modes = {
      alpha: () => new Response(leak, { status: 500 }),
      beta: () => answer(QUERIES),
      gamma: () => new Response(`not json ${leak}`, { status: 200 }),
      delta: () => answer(['solo una']), // fewer than the minimum of 2 survive
      epsilon: () => Response.json({ choices: [{ message: { content: `{"queries_es": "${leak}"` } }] }),
    };
    const fetchImpl = recorder((call) => modes[/Skill name: (\w+)/.exec(call.body.messages[1].content)[1]]());
    const log = captureLog();
    const result = await run(f, { fetchImpl, log });
    assert.deepEqual(result.enriched, ['beta']);
    assert.deepEqual(result.failed.map((x) => x.slug), ['alpha', 'gamma', 'delta', 'epsilon']);
    assert.deepEqual(result.skipped, []);
    assert.match(result.failed[0].error, /HTTP 500/);
    assert.match(result.failed[2].error, /expected at least 2/);
    for (const x of result.failed) assert.ok(!x.error.includes(leak) && !x.error.includes(KEY), x.error);
    assert.ok(!log.text().includes(leak) && !log.text().includes(KEY));
    assert.equal((await f.repo.getSkill('alpha')).enrichment_v, null);
    assert.equal((await f.repo.getSkill('beta')).enrichment_v, 1);
  } finally { f.close(); }
});

localTest('a network error and a timeout are failures without the thrown message', async () => {
  const f = await fixture(['alpha', 'beta']);
  try {
    const fetchImpl = recorder((call, n) => {
      if (n === 1) throw Object.assign(new Error(`connect failed for key ${KEY}`), { name: 'TypeError' });
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const result = await run(f, { fetchImpl });
    assert.deepEqual(result.enriched, []);
    assert.match(result.failed[0].error, /request failed/);
    assert.match(result.failed[1].error, /timed out/);
    assert.ok(!JSON.stringify(result).includes(KEY));
  } finally { f.close(); }
});

localTest('a skill republished while the request was in flight is skipped, not overwritten', async () => {
  const f = await fixture(['alpha']);
  try {
    const fetchImpl = recorder(async () => {
      await f.repo.publish(version('alpha', { body: 'a newer body' }));
      return answer(QUERIES);
    });
    const result = await run(f, { fetchImpl });
    assert.deepEqual(result.enriched, []);
    assert.deepEqual(result.skipped, [{ slug: 'alpha', reason: 'a new version was published meanwhile' }]);
    assert.equal((await f.repo.getSkill('alpha')).queries_es_text, '');
  } finally { f.close(); }
});

localTest('enrichCommand: prints the summary and exits 1 when one skill fails, 0 when none does', async () => {
  const f = await fixture(['alpha', 'beta']);
  try {
    const log = captureLog();
    const fetchImpl = recorder((call) => (call.body.messages[1].content.includes('Skill name: alpha') ? new Response('x', { status: 500 }) : answer(QUERIES)));
    const code = await enrichCommand({ repo: f.repo, slugs: [], stale: false, config: ON, env: { AI_GATEWAY_API_KEY: KEY }, dir: f.dir, fetchImpl, log });
    assert.equal(code, 1);
    assert.match(log.lines.at(-1), /^enriched: 1, skipped: 0, failed: 1/);
    assert.equal((await f.repo.getSkill('beta')).enrichment_v, 1);

    // The failed skill still has no Spanish text, so a retry takes just that one and succeeds.
    const retry = captureLog();
    assert.equal(await enrichCommand({ repo: f.repo, slugs: [], stale: false, config: ON, env: { AI_GATEWAY_API_KEY: KEY }, dir: f.dir, fetchImpl: recorder(), log: retry }), 0);
    assert.equal(retry.lines.at(-1), 'enriched: 1, skipped: 0, failed: 0');
  } finally { f.close(); }
});

localTest('enrichAfterImport enriches the published slugs only, and is silent when enrich is off or nothing was published', async () => {
  const f = await fixture(['alpha', 'beta']);
  try {
    await fsp.writeFile(path.join(f.dir, 'config.json'), JSON.stringify({ enrich: { enabled: true } }));
    const fetchImpl = recorder();
    const log = captureLog();
    await enrichAfterImport({ repo: f.repo, published: ['beta'], env: { AI_GATEWAY_API_KEY: KEY }, dir: f.dir, fetchImpl, log });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal((await f.repo.getSkill('beta')).enrichment_v, 1);
    assert.equal((await f.repo.getSkill('alpha')).enrichment_v, null);
    assert.equal(log.lines.at(-1), 'enriched: 1, skipped: 0, failed: 0');

    await fsp.writeFile(path.join(f.dir, 'config.json'), JSON.stringify({ enrich: { enabled: false } }));
    const quiet = captureLog();
    await enrichAfterImport({ repo: f.repo, published: ['alpha'], env: { AI_GATEWAY_API_KEY: KEY }, dir: f.dir, fetchImpl, log: quiet });
    assert.deepEqual(quiet.lines, []);
    assert.equal(fetchImpl.calls.length, 1);
  } finally { f.close(); }
});

localTest('enrichAfterImport never throws: a UserError is reported with its message, anything else with a fixed line', async () => {
  const f = await fixture(['alpha']);
  try {
    await fsp.writeFile(path.join(f.dir, 'config.json'), JSON.stringify({ enrich: { enabled: true } }));
    const leak = 'CONTENT-THAT-MUST-NOT-BE-LOGGED';
    // An unexpected error out of the repository (its message could carry content).
    const broken = { ...f.repo, listEnrichTargets: async () => { throw new Error(`disk said ${leak} ${KEY}`); } };
    const log = captureLog();
    await assert.doesNotReject(enrichAfterImport({ repo: broken, published: ['alpha'], env: { AI_GATEWAY_API_KEY: KEY }, dir: f.dir, fetchImpl: recorder(), log }));
    assert.deepEqual(log.lines, ['enrichment skipped: unexpected error (run headjack enrich to retry)']);

    // A key file in the wrong mode: a UserError that names the file.
    const file = path.join(f.dir, 'ai-gateway-key');
    await fsp.writeFile(file, `${KEY}\n`);
    await fsp.chmod(file, 0o644);
    const refused = captureLog();
    const fetchImpl = recorder();
    await assert.doesNotReject(enrichAfterImport({ repo: f.repo, published: ['alpha'], env: {}, dir: f.dir, fetchImpl, log: refused }));
    assert.equal(refused.lines.length, 1);
    assert.ok(refused.lines[0].startsWith(`enrichment skipped: ${file}:`), refused.lines[0]);
    assert.ok(!refused.text().includes(KEY));
    assert.equal(fetchImpl.calls.length, 0);

    // A malformed config key.
    await fsp.writeFile(path.join(f.dir, 'config.json'), JSON.stringify({ suggest: { enabled: 'x' } }));
    const malformed = captureLog();
    await assert.doesNotReject(enrichAfterImport({ repo: f.repo, published: ['alpha'], env: {}, dir: f.dir, fetchImpl, log: malformed }));
    assert.match(malformed.lines.join('\n'), /^enrichment skipped: .*"suggest\.enabled" must be true or false$/);
  } finally { f.close(); }
});

localTest('enrichAfterImport on a slug at ENRICHMENT_VERSION records no fetch and leaves two query chunks', async () => {
  const f = await fixture(['alpha']);
  try {
    const { skillId, versionId } = f.ids.alpha;
    await f.repo.setSpanish(skillId, versionId, 'consulta uno consulta dos', ENRICHMENT_VERSION);
    const insert = f.db.prepare("insert into chunks (skill_id, version_id, text, kind) values (?, ?, ?, 'query')");
    insert.run(skillId, versionId, 'consulta uno');
    insert.run(skillId, versionId, 'consulta dos');
    await fsp.writeFile(path.join(f.dir, 'config.json'), JSON.stringify({ enrich: { enabled: true } }));
    const fetchImpl = recorder();
    await enrichAfterImport({
      repo: f.repo, published: ['alpha'], env: { AI_GATEWAY_API_KEY: KEY }, dir: f.dir, fetchImpl, log: captureLog(),
    });
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(
      f.db.prepare("select text from chunks where kind = 'query' order by id").all().map((row) => row.text),
      ['consulta uno', 'consulta dos'],
    );
    assert.equal((await f.repo.getSkill('alpha')).queries_es_text, 'consulta uno consulta dos');
  } finally { f.close(); }
});

localTest('enrich with loadVec false and a chunk_vecs name does not throw or change Spanish', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-enrich-vec-');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  const repo = createSqliteRepo(db);
  const ids = await repo.publish(version('alpha'));
  db.exec('create table chunk_vecs (id integer)');
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/\bfrom\s+chunk_vecs\b/i.test(sql) || /\bjoin\s+chunk_vecs\b/i.test(sql) || /\binto\s+chunk_vecs\b/i.test(sql)) {
      throw new Error('no such module: vec0');
    }
    return prepare(sql);
  };
  let saw = null;
  const loadVec = (database) => {
    saw = database;
    database.enableLoadExtension(true);
    return false;
  };
  try {
    const fetchImpl = recorder();
    await assert.doesNotReject(enrichCommand({
      repo, db, slugs: ['alpha'], stale: false, config: ON, env: { AI_GATEWAY_API_KEY: KEY }, dir, fetchImpl, log: captureLog(), loadVec,
    }));
    assert.equal((await repo.getSkill('alpha')).queries_es_text, '');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(saw, db);
    assert.equal(ids.skillId > 0, true);
  } finally { db.close(); }
});

function vectorsFor(input) {
  return {
    object: 'list',
    data: input.map((_, index) => ({
      object: 'embedding',
      index,
      embedding: Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0)),
    })),
    model: 'openai/text-embedding-3-small',
    usage: { prompt_tokens: input.length, total_tokens: input.length },
  };
}

localTest('enrich with sqlite-vec stores one chunk per query and embeds a content chunk that has no vector', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-enrich-embed-');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  const repo = createSqliteRepo(db);
  const ids = await repo.publish(version('alpha'));
  db.prepare("insert into chunks (skill_id, version_id, text, kind) values (?, ?, ?, 'content')").run(ids.skillId, ids.versionId, 'alpha body text');
  const { loadVec } = await import('../../lib/local/vec.mjs');
  assert.equal(loadVec(db), true);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), input: body.input });
    if (String(url).includes('/embeddings')) return Response.json(vectorsFor(body.input));
    return answer(QUERIES);
  };
  try {
    const result = await enrichLocal({
      repo, db, slugs: ['alpha'], stale: false, config: ON, env: { AI_GATEWAY_API_KEY: KEY }, dir, fetchImpl, log: captureLog(),
    });
    assert.deepEqual(result.enriched, ['alpha']);
    assert.deepEqual(
      db.prepare("select text from chunks where kind = 'query' order by id").all().map((row) => row.text),
      QUERIES,
    );
    const embed = calls.filter((call) => String(call.url).includes('/embeddings'));
    assert.equal(embed.length > 0, true);
    assert.deepEqual(embed[0].input.slice(0, QUERIES.length), QUERIES);
    assert.equal(embed.some((call) => call.input.includes('alpha body text')), true);
    assert.equal((await repo.getSkill('alpha')).queries_es_text, QUERIES.join(' '));
    assert.equal(db.prepare('select count(*) as n from chunk_vecs').get().n > 0, true);
  } finally { db.close(); }
});

localTest('enrich with sqlite-vec writes nothing when the embedding fails', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-enrich-embed-fail-');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  const repo = createSqliteRepo(db);
  await repo.publish(version('alpha'));
  const { loadVec } = await import('../../lib/local/vec.mjs');
  assert.equal(loadVec(db), true);
  const fetchImpl = async (url) => (
    String(url).includes('/embeddings') ? new Response('no', { status: 502 }) : answer(QUERIES)
  );
  try {
    const result = await enrichLocal({
      repo, db, slugs: ['alpha'], stale: false, config: ON, env: { AI_GATEWAY_API_KEY: KEY }, dir, fetchImpl, log: captureLog(),
    });
    assert.deepEqual(result.enriched, []);
    assert.equal((await repo.getSkill('alpha')).queries_es_text, '');
    assert.equal(db.prepare("select count(*) as n from chunks where kind = 'query'").get().n, 0);
  } finally { db.close(); }
});

// ---- the CLI (spawned; no test here can reach the network) ----

async function sandbox(config) {
  const home = await tempDir('sv-ehome-');
  const state = path.join(home, '.headjack');
  await fsp.mkdir(state, { recursive: true });
  if (config !== undefined) await fsp.writeFile(path.join(state, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return { home, state, env: { HOME: home, HEADJACK_HOME: state } };
}

function runCli(args, { env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function importable(home, names) {
  const root = path.join(home, '.agents', 'skills');
  for (const n of names) {
    await fsp.mkdir(path.join(root, n), { recursive: true });
    await fsp.writeFile(path.join(root, n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n} does things\n---\n# ${n}\nUse it.\n`);
  }
}

// `import --dry-run` writes the plan that `import --interactive` then confirms.
async function importAll(sb, extraEnv = {}) {
  const env = { ...sb.env, ...extraEnv };
  const plan = await runCli(['import', '--dry-run'], { env });
  assert.equal(plan.code, 0, plan.stdout + plan.stderr);
  return runCli(['import', '--interactive'], { env, input: 'y\ny\ny\n' });
}

localTest('headjack enrich with enrich.enabled false: the notice, exit 0, nothing sent', async () => {
  const { env } = await sandbox({ enrich: { enabled: false } });
  const r = await runCli(['enrich'], { env: { ...env, AI_GATEWAY_API_KEY: KEY } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /enrich is off: set enrich\.enabled/);
  assert.ok(!(r.stdout + r.stderr).includes(KEY));
});

localTest('headjack enrich with a key file that is mode 0644: exit 2 naming the file', async () => {
  const { state, env } = await sandbox({ enrich: { enabled: true } });
  const file = path.join(state, 'ai-gateway-key');
  await fsp.writeFile(file, `${KEY}\n`);
  await fsp.chmod(file, 0o644);
  const r = await runCli(['enrich'], { env });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(file), r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(KEY));
});

localTest('headjack enrich with enrich.enabled and no key: the notice, exit 0; a malformed enrich key exits 2', async () => {
  const none = await sandbox({ enrich: { enabled: true } });
  const r = await runCli(['enrich', '--stale', 'some-slug'], { env: none.env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no AI Gateway key/);

  const bad = await sandbox({ enrich: { enabled: 'yes' } });
  const b = await runCli(['enrich'], { env: bad.env });
  assert.equal(b.code, 2, b.stdout + b.stderr);
  assert.match(b.stderr, /enrich\.enabled/);
});

test('headjack enrich in hosted mode exits 2: the server enriches hosted skills', async () => {
  const { env } = await sandbox({ enrich: { enabled: true } });
  const r = await runCli(['enrich'], { env: { ...env, HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't', AI_GATEWAY_API_KEY: KEY } });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the server enriches hosted skills/);
});

localTest('import in local mode: enabled without a key prints one notice, a malformed enrich key prints one and still exits 0, nothing is sent', async () => {
  const noKey = await sandbox({ enrich: { enabled: true } });
  await importable(noKey.home, ['alpha-skill']);
  const a = await importAll(noKey);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.match(a.stdout, /published: 1/);
  assert.equal(a.stdout.match(/no AI Gateway key/g)?.length, 1);

  const bad = await sandbox({ enrich: 'nope' });
  await importable(bad.home, ['beta-skill']);
  const b = await importAll(bad, { AI_GATEWAY_API_KEY: KEY });
  assert.equal(b.code, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /published: 1/);
  assert.match(b.stdout, /enrichment skipped: .*"enrich" must be an object/);
  assert.equal(b.stdout.match(/enrichment skipped/g)?.length, 1);
  assert.ok(!/enrichment is off/.test(b.stdout));
  assert.ok(!(b.stdout + b.stderr).includes(KEY));

  // A malformed suggest key (not enrich) also gives one notice and exit 0. No key is given: enrich is enabled here, so
  // a key would let a spawned CLI reach the real gateway if config validation ever stopped rejecting the whole file.
  const badSuggest = await sandbox({ suggest: { enabled: 'yes' }, enrich: { enabled: true } });
  await importable(badSuggest.home, ['zeta-skill']);
  const d = await importAll(badSuggest);
  assert.equal(d.code, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /published: 1/);
  assert.equal(d.stdout.match(/enrichment skipped/g)?.length, 1);
  assert.match(d.stdout, /suggest\.enabled/);
  assert.ok(!(d.stdout + d.stderr).includes(KEY));

  // enrich.enabled false: import says nothing about enrichment.
  const off = await sandbox({ enrich: { enabled: false } });
  await importable(off.home, ['gamma-skill']);
  const c = await importAll(off, { AI_GATEWAY_API_KEY: KEY });
  assert.equal(c.code, 0, c.stdout + c.stderr);
  assert.doesNotMatch(c.stdout + c.stderr, /enrich/i);
});

test('import in hosted mode never calls enrichLocal: no enrichment line even with enrich.enabled', async () => {
  const server = createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/api/skills') { req.resume(); req.on('end', () => json(201, { ok: true })); } else { req.resume(); json(404, { error: { code: 'not_found', message: 'nope' } }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const sb = await sandbox({ enrich: { enabled: true } });
    await importable(sb.home, ['delta-skill']);
    const r = await importAll(sb, { HEADJACK_URL: `http://127.0.0.1:${server.address().port}`, HEADJACK_TOKEN: 't' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /published: 1/);
    assert.doesNotMatch(r.stdout + r.stderr, /enrich|AI Gateway/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
