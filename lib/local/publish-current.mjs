// An approved publish reads content chunks before the version commits, so a tarball with no root SKILL.md fails
// before that sha is current. The Gateway runs only after the commit, and only when a key is set and sqlite-vec
// loaded. A second transaction then writes chunks. A secret, including one hidden after a NUL, or a Gateway failure
// still leaves the content chunks and posts nothing. enrich.enabled is not read. The CLI imports no npm package;
// this module does not import ai or lib/embed.mjs.
import { embedTexts } from '../../cli/embed-local.mjs';
import { findSecrets } from '../../cli/scan.mjs';
import { ENRICH_ES_JSON_SCHEMA, ENRICHMENT_VERSION, buildPrompt } from '../enrich-prompt.mjs';
import { LIMITS, cleanQueries, stripUnsafe } from '../enrichment-limits.mjs';
import { chunkSkill, readSkillInfo } from '../skillmd.mjs';
import { unpack } from '../tar.mjs';
import { loadVec } from './vec.mjs';

const CHAT_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const CHAT_MODEL = 'openai/gpt-5-mini';
const REQUEST_TIMEOUT_MS = 30000;
const NAME_CHUNK_LIMIT = 1000;

function chunkTexts(chunks) {
  if (!Array.isArray(chunks)) return [];
  const texts = [];
  for (const chunk of chunks) {
    if (typeof chunk === 'string') texts.push(chunk);
    else if (chunk && typeof chunk.text === 'string') texts.push(chunk.text);
  }
  return texts;
}

export function contentChunks({ manifest, tarball, chunks }) {
  const standalone = manifest.kind === 'skill' && !manifest.plugin_slug;
  if (tarball && standalone) return chunkSkill(readSkillInfo(unpack(tarball), manifest.slug));
  const listed = chunkTexts(chunks);
  if (listed.length) return listed;
  return [`${manifest.name}: ${manifest.description}`.slice(0, NAME_CHUNK_LIMIT)];
}

function flagged(strings) {
  const files = [];
  strings.forEach((text, index) => {
    if (typeof text !== 'string' || text === '') return;
    // findSecrets treats a NUL in the first 8000 bytes as binary and returns no hit. Scan each text segment so a
    // secret after that NUL still takes the no-vector branch and is never posted.
    text.split('\0').forEach((part, partIndex) => {
      if (part === '') return;
      files.push({ path: `part-${index}-${partIndex}.txt`, data: Buffer.from(part) });
    });
  });
  return files.length > 0 && findSecrets(files).length > 0;
}

function promptFor(manifest, content) {
  return buildPrompt({
    name: stripUnsafe(String(manifest.name ?? '')),
    description: stripUnsafe(String(manifest.description ?? '')),
    body: stripUnsafe(content.join('\n')),
  }, { spanishOnly: true });
}

function extensionsAllowed(db) {
  try {
    db.enableLoadExtension(true);
    return true;
  } catch {
    return false;
  }
}

function chunkVecsPresent(db) {
  return db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n === 1;
}

// Load only when this publish might embed or might have to delete rows. A no-key publish must not create the table:
// a later open without the extension treats a chunk_vecs name as vectors that cannot be queried.
function vecReady(db, key) {
  if (!key && !chunkVecsPresent(db)) return false;
  if (!extensionsAllowed(db)) return false;
  try {
    return loadVec(db) === true;
  } catch {
    return false;
  }
}

function isVecError(error) {
  return /chunk_vecs|vec0|knn|float|only integers are allows/i.test(String(error?.message ?? ''));
}

async function spanishQueries({ manifest, content, key, fetchImpl }) {
  const { system, prompt } = promptFor(manifest, content);
  if (flagged([system, prompt, ...content])) return null;
  let res;
  try {
    res = await fetchImpl(CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'enrich_es',
            strict: true,
            schema: { ...ENRICH_ES_JSON_SCHEMA, additionalProperties: false },
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('request failed (network error)');
  }
  if (!res?.ok) throw new Error(`gateway returned HTTP ${res?.status ?? 'error'}`);
  let contentText;
  try {
    contentText = (await res.json())?.choices?.[0]?.message?.content;
  } catch {
    throw new Error('response is not valid JSON');
  }
  if (typeof contentText !== 'string') throw new Error('response has no message content');
  let parsed;
  try {
    parsed = JSON.parse(contentText);
  } catch {
    throw new Error('response content is not valid JSON');
  }
  if (!Array.isArray(parsed?.queries_es)) throw new Error('response has no queries_es list');
  return cleanQueries(parsed.queries_es, new Set(), LIMITS.es, 'Spanish');
}

async function embedBranch({ manifest, content, queriesEs, enrichmentV, key, fetchImpl }) {
  const { system, prompt } = promptFor(manifest, content);
  let queryChunks;
  if (enrichmentV === ENRICHMENT_VERSION) {
    const queryText = typeof queriesEs === 'string' ? queriesEs : '';
    if (flagged([system, prompt, ...content, queryText])) return null;
    queryChunks = queryText === '' ? [] : [queryText];
  } else {
    const queries = await spanishQueries({ manifest, content, key, fetchImpl });
    if (!queries) return null;
    if (flagged(queries)) return null;
    queryChunks = queries;
  }
  const inputs = [...content, ...queryChunks];
  if (flagged(inputs)) return null;
  const vectors = await embedTexts({ texts: inputs, key, fetchImpl });
  return { queryChunks, vectors, queriesEsText: queryChunks.join(' ') };
}

// The second transaction, shared with setCurrentVersion. The Gateway has already finished or been skipped. A missing
// key or a false loadVec still stores the content chunk texts and leaves Spanish empty.
export async function finishCurrent({
  repo, db, manifest, content, queriesEs = null, enrichmentV = null, key, fetchImpl = fetch, skillId, versionId,
}) {
  const vecLoaded = vecReady(db, key);
  let embedded = null;
  if (key && vecLoaded) {
    try {
      embedded = await embedBranch({ manifest, content, queriesEs, enrichmentV, key, fetchImpl });
    } catch {
      embedded = null;
    }
  }
  const success = Array.isArray(embedded?.vectors);
  await writeChunks(repo, {
    skillId,
    versionId,
    contentChunks: content,
    queryChunks: success ? embedded.queryChunks : [],
    vectors: success ? embedded.vectors : null,
    queriesEs: success ? embedded.queriesEsText : '',
    enrichmentV: success ? ENRICHMENT_VERSION : null,
    vecLoaded,
  });
  return { skillId, versionId };
}

async function writeChunks(repo, args) {
  try {
    await repo.replaceChunks(args);
  } catch (error) {
    if (!args.vecLoaded || !isVecError(error)) throw error;
    const contentOnly = { ...args, queryChunks: [], vectors: null, queriesEs: '' };
    try {
      // An insertion failure does not imply that cleanup is unavailable.
      await repo.replaceChunks(contentOnly);
    } catch (cleanupError) {
      if (!isVecError(cleanupError)) throw cleanupError;
      // The loaded vector table itself is unusable. Preserve the content-only fallback.
      await repo.replaceChunks({ ...contentOnly, vecLoaded: false });
    }
  }
}

// `db` was opened by the caller. This function does not call loadExtension on any other connection, and it does not
// call loadVec unless that connection was allowed to load extensions.
export async function publishCurrent({
  repo, db, manifest, tarball = null, chunks, queriesEs = null, enrichmentV = null, key, fetchImpl = fetch,
}) {
  // A standalone tarball with no root SKILL.md must fail before insert. Otherwise this sha is current, replaceChunks
  // never runs, and a later valid tarball of the same sha is 409 while chunks still belong to the previous version.
  const approved = manifest?.status === 'approved';
  const content = approved ? contentChunks({ manifest, tarball, chunks }) : null;
  const published = await repo.publish({
    manifest,
    tarball,
    chunks: chunkTexts(chunks).map((text) => ({ text, kind: 'content' })),
  });
  if (!approved) return { skillId: published.skillId, versionId: published.versionId };

  return finishCurrent({
    repo, db, manifest, content, queriesEs, enrichmentV, key, fetchImpl,
    skillId: published.skillId,
    versionId: published.versionId,
  });
}
