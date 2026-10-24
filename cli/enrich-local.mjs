// Opt-in Spanish enrichment of the local vault (spec §8.3). It sends each skill's name, description and clipped body to
// the Vercel AI Gateway and stores the Spanish example requests it returns. Nothing leaves the machine unless
// enrich.enabled is true and a key is present, and the exact payload is secret-scanned first. The key and the prompt and
// response texts are never printed or logged: only slugs, counts and fixed reasons. Node built-ins only.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../lib/errors.mjs';
import { ENRICH_ES_JSON_SCHEMA, ENRICHMENT_VERSION, MAX_BODY_CHARS, buildPrompt } from '../lib/enrich-prompt.mjs';
import { LIMITS, cleanQueries, stripUnsafe } from '../lib/enrichment-limits.mjs';
import { loadSuggestConfig } from '../lib/suggest-config.mjs';
import { findSecrets } from './scan.mjs';
import { loadVec as defaultLoadVec } from '../lib/local/vec.mjs';

export const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';
// A reasoning model answers in about 6 s; this is the ceiling for one request.
export const REQUEST_TIMEOUT_MS = 30000;
const KEY_FILE = 'ai-gateway-key';
const KEY_MODE = 0o600;

// The AI Gateway key: AI_GATEWAY_API_KEY from the environment, else <dir>/ai-gateway-key, which is accepted only when
// it is a regular file of mode exactly 0600 (a UserError naming the file otherwise). Trimmed; null when there is none.
// The file is opened without following a symlink (ELOOP: refused) and without blocking, so a FIFO cannot hang the command;
// its type and mode are checked on the open handle before anything is read.
export async function aiGatewayKey({ env = process.env, dir }) {
  const fromEnv = typeof env.AI_GATEWAY_API_KEY === 'string' ? env.AI_GATEWAY_API_KEY.trim() : '';
  if (fromEnv) return fromEnv;
  const file = path.join(dir, KEY_FILE);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ELOOP') throw new UserError(`${file}: the AI Gateway key file must not be a symlink`);
    throw new UserError(`${file}: cannot read the AI Gateway key file (${e.code ?? 'error'})`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== KEY_MODE) {
      throw new UserError(`${file}: the AI Gateway key file must be a regular file with mode 0600 (chmod 600 ${file})`);
    }
    return (await handle.readFile('utf8')).trim() || null;
  } finally {
    await handle.close();
  }
}

// Fixed, content-free reasons only: a thrown error or a response body can carry the key or the text, so none is quoted.
function requestFailure(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  return 'request failed (network error)';
}

function extensionsAllowed(db) {
  try {
    db.enableLoadExtension(true);
    return true;
  } catch {
    return false;
  }
}

function chunkVecsNamed(db) {
  return db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n === 1;
}

// 'blocked' is a chunk_vecs name that cannot be queried. Do not select that table: vec0 is not loaded.
function vecDecision(db, loadVecImpl) {
  if (!db) return 'text';
  if (!extensionsAllowed(db)) return chunkVecsNamed(db) ? 'blocked' : 'text';
  let loaded = false;
  try {
    loaded = loadVecImpl(db) === true;
  } catch (error) {
    if (String(error?.message ?? '').includes('extension loading is not allowed')) throw error;
    loaded = false;
  }
  if (loaded) return 'vectors';
  return chunkVecsNamed(db) ? 'blocked' : 'text';
}

function hasSecret(strings) {
  const files = [];
  strings.forEach((text, index) => {
    if (typeof text !== 'string' || text === '') return;
    text.split('\0').forEach((part, partIndex) => {
      if (part === '') return;
      files.push({ path: `part-${index}-${partIndex}.txt`, data: Buffer.from(part) });
    });
  });
  return files.length > 0 && findSecrets(files).length > 0;
}

function contentWithoutVectors(db, skillId, versionId) {
  return db.prepare(
    `select c.id, c.text from chunks c
      where c.skill_id = ? and c.version_id = ? and c.kind = 'content'
        and not exists (select 1 from chunk_vecs v where v.rowid = c.id)`,
  ).all(skillId, versionId);
}

async function embedEnrichment({ db, skillId, versionId, queries, key, fetchImpl }) {
  const missing = contentWithoutVectors(db, skillId, versionId);
  const texts = [...queries, ...missing.map((row) => row.text)];
  if (hasSecret(texts)) return null;
  const { embedTexts } = await import('./embed-local.mjs');
  const vectors = await embedTexts({ texts, key, fetchImpl });
  return {
    queryVectors: vectors.slice(0, queries.length),
    contentVectors: missing.map((row, index) => ({ id: row.id, vector: vectors[queries.length + index] })),
  };
}

async function queriesFor({ payload, model, key, fetchImpl }) {
  const { system, prompt } = buildPrompt(payload, { spanishOnly: true });
  let res;
  try {
    res = await fetchImpl(GATEWAY_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'enrich_es', strict: true, schema: { ...ENRICH_ES_JSON_SCHEMA, additionalProperties: false } } },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(requestFailure(e));
  }
  if (!res.ok) throw new Error(`gateway returned HTTP ${res.status}`);
  let content;
  try {
    content = (await res.json())?.choices?.[0]?.message?.content;
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? requestFailure(e) : 'response is not valid JSON');
  }
  if (typeof content !== 'string') throw new Error('response has no message content');
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error('response content is not valid JSON'); }
  if (!Array.isArray(parsed?.queries_es)) throw new Error('response has no queries_es list');
  return cleanQueries(parsed.queries_es, new Set(), LIMITS.es, 'Spanish'); // throws below the minimum: counts only
}

// Enriches skills of the local vault. `slugs` selects those skills (else the default set of repo.listEnrichTargets:
// skills with no Spanish text; with `stale`, those whose enrichment_v is null or older than ENRICHMENT_VERSION).
// `config` is loadSuggestConfig's result. Returns { enriched: slug[], skipped: [{ slug, reason }], failed: [{ slug, error }] }.
// A key file in the wrong mode throws a UserError. `log` receives one notice when enrichment is off or has no key, and one
// line per skill.
export async function enrichLocal({
  repo, slugs, stale = false, config, env = process.env, dir, fetchImpl = fetch, log = () => {}, db = null, loadVec = defaultLoadVec,
}) {
  const result = { enriched: [], skipped: [], failed: [] };
  if (!config.enrich.enabled) {
    log('enrich is off: set enrich.enabled to true in config.json to send skill text to the AI Gateway');
    return result;
  }
  const key = await aiGatewayKey({ env, dir });
  if (!key) {
    log(`enrich: no AI Gateway key, nothing was sent (set AI_GATEWAY_API_KEY, or put the key in ${path.join(dir, KEY_FILE)} with mode 0600)`);
    return result;
  }
  const database = db ?? repo.db ?? null;
  const decision = vecDecision(database, loadVec);
  if (decision === 'blocked') return result;
  const vectors = decision === 'vectors';

  const wanted = slugs?.length ? [...new Set(slugs)] : null;
  const targets = await repo.listEnrichTargets({ slugs: wanted, stale });
  const skip = (slug, reason) => { result.skipped.push({ slug, reason }); log(`skipped ${slug}: ${reason}`); };
  for (const slug of wanted ?? []) {
    if (!targets.some((t) => t.slug === slug)) skip(slug, 'nothing to enrich (unknown slug or already current)');
  }

  for (const t of targets) {
    // The exact payload: the text is made safe once, and what is scanned is what is sent.
    const payload = {
      name: stripUnsafe(String(t.name)),
      description: stripUnsafe(String(t.description)),
      body: stripUnsafe(String(t.body)).slice(0, MAX_BODY_CHARS),
    };
    const found = findSecrets(Object.entries(payload).map(([field, text]) => ({ path: field, data: Buffer.from(text) })));
    if (found.length) { skip(t.slug, `secret-scan flagged ${found[0].pattern}`); continue; }
    try {
      const queries = await queriesFor({ payload, model: config.enrich.model, key, fetchImpl });
      if (vectors) {
        if (hasSecret(queries)) { skip(t.slug, 'secret-scan flagged query'); continue; }
        const embedded = await embedEnrichment({ db: database, skillId: t.id, versionId: t.version_id, queries, key, fetchImpl });
        if (!embedded) { skip(t.slug, 'secret-scan flagged query'); continue; }
        const wrote = await repo.replaceSpanishChunks({
          skillId: t.id,
          versionId: t.version_id,
          queriesEsText: queries.join(' '),
          enrichmentV: ENRICHMENT_VERSION,
          queryChunks: queries,
          queryVectors: embedded.queryVectors,
          contentVectors: embedded.contentVectors,
        });
        if (!wrote) { skip(t.slug, 'a new version was published meanwhile'); continue; }
      } else if (!(await repo.setSpanish(t.id, t.version_id, queries.join(' '), ENRICHMENT_VERSION))) {
        skip(t.slug, 'a new version was published meanwhile');
        continue;
      }
      result.enriched.push(t.slug);
      log(`enriched ${t.slug}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'enrichment failed';
      result.failed.push({ slug: t.slug, error });
      log(`failed ${t.slug}: ${error}`);
    }
  }
  return result;
}

export const enrichSummary = (e) => `enriched: ${e.enriched.length}, skipped: ${e.skipped.length}, failed: ${e.failed.length}${e.failed.length ? ' (headjack enrich retries the skills that still have no Spanish text)' : ''}`;

// The body of `headjack enrich`: enriches, prints the summary through `log` and returns the exit code (1 when any skill
// failed). A UserError from enrichLocal (a refused key file) propagates: the CLI reports it and exits 2.
export async function enrichCommand({ repo, slugs, stale, config, env, dir, fetchImpl, log, db, loadVec }) {
  const result = await enrichLocal({ repo, slugs, stale, config, env, dir, fetchImpl, log, db, loadVec });
  log(enrichSummary(result));
  return result.failed.length ? 1 : 0;
}

// Enrichment after a local `import`, over the slugs it published. A best effort that never throws, so it can never change
// import's exit code: a UserError (a bad config, a refused key file) is reported with its message, which names only a file
// or a key; anything else with a fixed line, because an unexpected error's message could carry content.
export async function enrichAfterImport({ repo, published, env, dir, fetchImpl, log }) {
  try {
    const config = await loadSuggestConfig(dir);
    if (!config.enrich.enabled || !published.length) return;
    const targets = await repo.listEnrichTargets({ slugs: published });
    const pending = targets.filter((target) => target.enrichment_v !== ENRICHMENT_VERSION).map((target) => target.slug);
    if (!pending.length) return;
    const result = await enrichLocal({ repo, slugs: pending, stale: false, config, env, dir, fetchImpl, log });
    if (result.enriched.length + result.skipped.length + result.failed.length) log(enrichSummary(result));
  } catch (e) {
    try {
      log(e instanceof UserError ? `enrichment skipped: ${e.message}` : 'enrichment skipped: unexpected error (run headjack enrich to retry)');
    } catch { /* a failing logger must not fail the import either */ }
  }
}
