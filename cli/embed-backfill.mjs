// Explicit, resumable local backfill. Preflight never bootstraps or migrates a vault.
import { existsSync } from 'node:fs';
import { aiGatewayKey, embedTexts } from './embed-local.mjs';
import { findSecrets } from './scan.mjs';
import { runtimeCheck } from '../lib/local/runtime.mjs';
import { MIGRATIONS, vaultFile, isBusy } from '../lib/local/schema.mjs';
import { loadVec as defaultLoadVec } from '../lib/local/vec.mjs';
import { createSqliteRepo } from '../lib/local/sqlite-repo.mjs';
import { chunkSkill, readSkillInfo } from '../lib/skillmd.mjs';
import { unpack } from '../lib/tar.mjs';
import { ENRICHMENT_VERSION, ENRICH_ES_JSON_SCHEMA, buildPrompt } from '../lib/enrich-prompt.mjs';
import { stripUnsafe, cleanQueries, LIMITS } from '../lib/enrichment-limits.mjs';
import { GATEWAY_URL, REQUEST_TIMEOUT_MS } from './enrich-local.mjs';
import { UserError } from '../lib/errors.mjs';

const CHAT_MODEL = 'openai/gpt-5-mini';
const BUSY_TIMEOUT_MS = 5000;
const summary = r => `examined: ${r.examined}, embedded: ${r.embedded}, skipped: ${r.skipped}, failed: ${r.failed}`;
function secret(texts) {
  return findSecrets(texts.flatMap((text, i) => String(text).split('\0').map((part, j) => ({ path: `${i}-${j}.txt`, data: Buffer.from(part) })))).length > 0;
}
async function complete(prompt, key, fetchImpl) {
  const response = await fetchImpl(GATEWAY_URL, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.prompt }], response_format: { type: 'json_schema', json_schema: { name: 'enrich_es', strict: true, schema: { ...ENRICH_ES_JSON_SCHEMA, additionalProperties: false } } } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('enrichment failed');
  const parsed = JSON.parse((await response.json())?.choices?.[0]?.message?.content);
  if (!Array.isArray(parsed?.queries_es)) throw new Error('enrichment failed');
  return cleanQueries(parsed.queries_es, new Set(), LIMITS.es, 'Spanish');
}

export async function embedCommand({ dir, env = process.env, fetchImpl = fetch, log = () => {}, loadVec = defaultLoadVec }) {
  const key = await aiGatewayKey({ dir, env });
  if (!key) { log('embed: no AI Gateway key'); return 2; }
  const { DatabaseSync } = await runtimeCheck();
  const probe = new DatabaseSync(':memory:', { allowExtension: true });
  try {
    if (!loadVec(probe)) { log('embed: vec unavailable'); return 2; }
  } finally { probe.close(); }
  const counts = { examined: 0, embedded: 0, skipped: 0, failed: 0 };
  if (!existsSync(vaultFile(dir))) { log(summary(counts)); return 0; }
  const db = new DatabaseSync(vaultFile(dir), { allowExtension: true });
  try {
    db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('pragma foreign_keys = ON');
    // Actual loading and migrations are atomic; a failed real connection load cannot advance a legacy schema.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!loadVec(db)) { db.exec('ROLLBACK'); log('embed: vec unavailable'); return 2; }
      const applied = db.prepare('pragma user_version').get().user_version;
      if (applied > MIGRATIONS.length) throw new UserError('vault was written by a newer headjack');
      for (const migration of MIGRATIONS.slice(applied)) db.exec(migration);
      if (applied < MIGRATIONS.length) db.exec(`pragma user_version = ${MIGRATIONS.length}`);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    db.exec('delete from chunk_vecs where not exists (select 1 from skills s where s.current_version_id = chunk_vecs.version_id)');
    const repo = createSqliteRepo(db);
    const targets = db.prepare(`select s.*, v.tarball, coalesce(d.body, '') body from skills s join versions v on v.id=s.current_version_id left join skill_docs d on d.rowid=s.id order by s.id`).all();
    for (const target of targets) {
      counts.examined++;
      const chunks = db.prepare(`select c.*, exists(select 1 from chunk_vecs v where v.rowid=c.id) embedded from chunks c where c.skill_id=? and c.version_id=? order by c.id`).all(target.id, target.current_version_id);
      const expectedState = { queriesEs: target.queries_es_text, enrichmentV: target.enrichment_v, body: target.body, chunks };
      const storedContent = chunks.filter(c => c.kind === 'content').map(c => c.text);
      const current = target.enrichment_v !== null && target.enrichment_v >= ENRICHMENT_VERSION;
      const matches = !target.queries_es_text || chunks.filter(c => c.kind === 'query').map(c => c.text).join(' ') === target.queries_es_text;
      if (current && storedContent.length && chunks.every(c => c.embedded) && matches) { counts.skipped++; continue; }
      let content;
      try {
        content = storedContent.length ? storedContent : target.tarball
          ? chunkSkill(readSkillInfo(unpack(Buffer.from(target.tarball)), target.slug)) : [target.body];
        const prompt = buildPrompt({ name: stripUnsafe(target.name), description: stripUnsafe(target.description), body: stripUnsafe(content.join('\n')) }, { spanishOnly: true });
        let queries = current && target.queries_es_text ? [target.queries_es_text] : [];
        let skipped = secret([prompt.system, prompt.prompt, ...content, ...queries]);
        if (!skipped && !current) {
          queries = await complete(prompt, key, fetchImpl);
          skipped = secret(queries);
        }
        if (skipped) {
          await repo.replaceChunks({ skillId: target.id, versionId: target.current_version_id, contentChunks: content, vecLoaded: true, preserveSpanish: current, expectedState });
          counts.skipped++;
          continue;
        }
        const vectors = await embedTexts({ texts: [...content, ...queries], key, fetchImpl, model: env.EMBED_MODEL || 'openai/text-embedding-3-small' });
        const wrote = await repo.replaceChunks({ skillId: target.id, versionId: target.current_version_id, contentChunks: content, queryChunks: queries, queriesEs: queries.join(' '), vectors, vecLoaded: true, expectedState });
        counts[wrote ? 'embedded' : 'skipped']++;
      } catch (error) {
        if (isBusy(error)) throw error;
        if (content) await repo.replaceChunks({ skillId: target.id, versionId: target.current_version_id, contentChunks: content, vecLoaded: true, preserveSpanish: current, expectedState });
        counts.failed++;
      }
    }
    log(summary(counts));
    return counts.failed ? 1 : 0;
  } finally { db.close(); }
}
