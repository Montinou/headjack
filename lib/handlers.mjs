import { createHmac, randomUUID } from 'node:crypto';
import { bearerMatches } from './auth.mjs';
import { ConflictError, ForbiddenError } from './errors.mjs';
import { hashFiles } from './hash.mjs';
import { rankSkills } from './search.mjs';
import { parseSkillMd } from './skillmd.mjs';
import { limitEnrichment } from './enrichment-limits.mjs';
import { MAX_TAGS, mergeTags, normalizeTag } from './tags.mjs';
import { unpack } from './tar.mjs';
import { checkUpstream } from './upstream.mjs';

export const SLUG_RE = /^[A-Za-z0-9._@:-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SOURCE_KINDS = new Set(['github', 'git', 'marketplace', 'local']);
const CATALOG_DEFAULT_LIMIT = 24;
const CATALOG_MAX_LIMIT = 100;
export const ENRICH_TIMEOUT_MS = 20_000;
// Measurement (spec §3.5). The session id is client-supplied: used for measurement only, never for authorization.
const SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;
// The contract's purposes; only `suggest` is logged.
export const PURPOSES = new Set(['suggest', 'plan', 'manual', 'eval', 'warmup']);
const INSTALL_SOURCES = new Set(['suggest', 'plan', 'manual']);
const EVENT_RETENTION_DAYS = 90;
const MISSING_HMAC_KEY = 'SEARCH_EVENTS_HMAC_KEY missing: exposure logging disabled';

// The x-headjack-session header when it is a valid session id, else null.
const sessionHeader = (req) => {
  const v = req.headers.get('x-headjack-session');
  return v != null && SESSION_RE.test(v) ? v : null;
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status, code, message) => json(status, { error: { code, message } });

export function slugFromPath(url) {
  return decodeURIComponent(new URL(url).pathname.split('/')[3] ?? '');
}

// ?tag=a&tag=b,c → ['a','b','c'], normalized like stored tags (`three.js` → `threejs`) and deduped; empty items are
// skipped. null when a value normalizes to nothing (e.g. `!!!`) or there are too many.
const rawTagFilter = (params) => params.getAll('tag').flatMap((v) => v.split(',')).map((t) => t.trim()).filter(Boolean);
const parseTagFilter = (params) => normalizeTagList(rawTagFilter(params));

const TAG_FILTER_MESSAGE = `each tag needs a letter or digit (a-z, 0-9), at most ${MAX_TAGS} tags`;

// A list of raw tag strings, normalized like stored tags and deduped; null when it is not a list of strings, a value
// normalizes to nothing, or there are too many.
function normalizeTagList(list) {
  if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) return null;
  const tags = [...new Set(list.map(normalizeTag))];
  if (tags.length > MAX_TAGS || tags.some((t) => !t)) return null;
  return tags;
}

// The POST /api/search body cap: a query, a few filters and nothing else.
export const SEARCH_BODY_MAX_BYTES = 4096;

// The JSON object in the request body, read up to `max` bytes. { tooLarge: true } past the cap (the declared length is
// checked first, then the bytes actually read), { bad: true } when the body is not a JSON object.
async function readJsonObject(req, max) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  const chunks = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { bad: true };
  } catch {
    return { bad: true };
  }
}

// The validation GET and POST /api/search share. `tags` is the raw list (strings); null/absent means none. Returns
// { q, k, kind, tags } or { error: Response }.
function searchParams({ q, k, kind, tags }) {
  const query = typeof q === 'string' ? q.trim() : '';
  if (!query) return { error: fail(400, 'bad_request', 'q is required') };
  if (!Number.isInteger(k) || k < 1 || k > 25) return { error: fail(400, 'bad_request', 'k must be an integer in [1,25]') };
  if (kind && kind !== 'skill' && kind !== 'plugin') return { error: fail(400, 'bad_request', 'kind must be skill or plugin') };
  const normalized = normalizeTagList(tags ?? []);
  if (!normalized) return { error: fail(400, 'bad_request', TAG_FILTER_MESSAGE) };
  return { q: query, k, kind: kind || null, tags: normalized };
}

export function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'manifest must be an object';
  if (typeof m.slug !== 'string' || !SLUG_RE.test(m.slug)) return 'invalid slug';
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name is required';
  if (typeof m.description !== 'string' || !m.description.trim()) return 'description is required';
  if (m.kind !== 'skill' && m.kind !== 'plugin') return 'kind must be skill or plugin';
  if (m.status !== 'approved' && m.status !== 'rejected') return 'status must be approved or rejected';
  if (typeof m.sha256 !== 'string' || !SHA_RE.test(m.sha256)) return 'sha256 must be 64 hex chars';
  if (m.plugin_slug != null && (typeof m.plugin_slug !== 'string' || !SLUG_RE.test(m.plugin_slug))) return 'invalid plugin_slug';
  if (m.source != null && (typeof m.source !== 'object' || !SOURCE_KINDS.has(m.source.kind))) return 'invalid source';
  if (m.scan_flags != null && !Array.isArray(m.scan_flags)) return 'scan_flags must be an array';
  if (m.tags != null && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string'))) return 'tags must be strings';
  if (!Array.isArray(m.chunks) || m.chunks.some((c) => typeof c !== 'string')) return 'chunks must be an array of strings';
  if (m.status === 'approved' && (m.chunks.length < 1 || m.chunks.length > 40)) return 'approved versions need 1..40 chunks';
  return null;
}

function skillBody(files) {
  const f = files?.find((x) => x.path === 'SKILL.md');
  return f ? parseSkillMd(f.data.toString('utf8')).body : '';
}

// Resolves to the enrichment or null. Never throws: a failed or slow enrichment must not fail a publish.
// The injected enricher is not trusted: its output is re-limited (charset, length, count) here.
async function tryEnrich(enrich, skill, slug, timeoutMs, log) {
  if (!enrich) return null;
  let timer;
  const pending = Promise.resolve().then(() => enrich(skill));
  pending.catch(() => {}); // a late rejection after the timeout is expected, not unhandled
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const out = await Promise.race([pending, timeout]);
    const strings = (list) => Array.isArray(list) && list.every((q) => typeof q === 'string');
    if (!strings(out?.queries_en) || !strings(out?.queries_es) || !Array.isArray(out?.tags)) {
      throw new Error('enrichment returned an invalid result');
    }
    return limitEnrichment(out);
  } catch (e) {
    log(`enrichment failed for ${slug}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// identify(req) → Promise<{ ownerId } | null> (lib/identity.mjs); repoFor(ownerId) → the repo scoped to that owner
// (repoForOwner in lib/repo.mjs); listOwnerIds() → every owner id, for the cron only.
// resolveFlags(req, { ownerId, sessionId }) → Promise<{ bilingualFts: boolean, ranking: 'rrf-english'|'rrf-bilingual' }>:
// the search flags (spec §3.6). Absent, throwing or any other value → control.
// hmacKey keys the query HMAC of exposure events (absent: exposure logging is skipped); eventCapMs caps the wait for
// that insert. overridden(req) → boolean: true when the request pins its flag values by hand (an evaluation run), so its
// exposure is not logged; absent: never.
// mapError(e) → Response | null: asked first when a user route throws; a Response is the answer, null keeps the
// ForbiddenError / internal fallbacks. embed absent (local mode): search is text-only and publish stores the manifest
// chunks without embeddings or enrichment.
export function createHandlers({ identify, repoFor, listOwnerIds, embed, enrich, mapError, env, fetchImpl = fetch, enrichTimeoutMs = ENRICH_TIMEOUT_MS, log = console.error, resolveFlags, hmacKey = env.SEARCH_EVENTS_HMAC_KEY, eventCapMs = 500, overridden = () => false }) {
  let hmacKeyWarned = false;
  // The full-text path search takes: 'rrf-bilingual' (adds the Spanish branch of repo.searchText) only when the kill
  // switch is on and the ranking flag picks it; 'rrf-english' (control) otherwise, including any flag failure.
  async function searchVariant(req, ids) {
    if (!resolveFlags) return 'rrf-english';
    try {
      const flags = await resolveFlags(req, ids);
      return flags?.bilingualFts === true && flags?.ranking === 'rrf-bilingual' ? 'rrf-bilingual' : 'rrf-english';
    } catch (e) {
      log(`search flags unavailable, using control: ${e?.message}`);
      return 'rrf-english';
    }
  }
  const internal = (e) => {
    console.error(e);
    return fail(500, 'internal', 'internal error');
  };
  // Every user route: resolve the owner first; the handler only ever sees that owner's repo (and its id, for flags).
  const authed = (fn) => async (req) => {
    let response;
    try {
      const who = await identify(req);
      response = who
        ? await fn(req, repoFor(who.ownerId), who.ownerId)
        : fail(401, 'unauthorized', 'missing or invalid credentials');
    } catch (e) {
      response = mapError?.(e) ?? (e instanceof ForbiddenError ? fail(403, 'forbidden', e.message) : internal(e));
    }
    response.headers.set('cache-control', 'private, no-store');
    return response;
  };
  const cronGuarded = (fn) => async (req) => {
    if (!bearerMatches(req, env.CRON_SECRET)) return fail(401, 'unauthorized', 'missing or invalid bearer token');
    try {
      return await fn(req);
    } catch (e) {
      return internal(e);
    }
  };
  const withSlug = (fn) => async (req, repo) => {
    const slug = slugFromPath(req.url);
    if (!SLUG_RE.test(slug)) return fail(400, 'bad_request', 'invalid slug');
    return fn(req, repo, slug);
  };

  // Content chunks and synthetic queries go to the embedder in one call; each chunk keeps its kind.
  // If that call fails, the content chunks alone are retried so enrichment cannot fail the publish.
  async function embedChunks(content, queries, slug) {
    const texts = [...content, ...queries];
    let vectors;
    try {
      vectors = await embed(texts);
    } catch (e) {
      if (!queries.length) throw e;
      log(`embedding with synthetic queries failed for ${slug}: ${e.message}; retrying with content chunks only`);
      return embedChunks(content, [], slug);
    }
    return texts.map((text, i) => ({ text, embedding: vectors[i], kind: i < content.length ? 'content' : 'query' }));
  }

  // Records a `suggest` exposure: HMAC of the query, never its text. Waits at most eventCapMs; a timeout or failure is
  // logged by message only and never fails the search.
  async function logExposure(repo, { sessionId, variant, q, topSlugs }) {
    if (!hmacKey) {
      if (!hmacKeyWarned) {
        hmacKeyWarned = true;
        log(MISSING_HMAC_KEY);
      }
      return;
    }
    const queryHmac = createHmac('sha256', hmacKey).update(q).digest('hex');
    let timer;
    const insert = Promise.resolve().then(() => repo.logSearchEvent({ sessionId, variant, queryHmac, topSlugs }));
    insert.catch(() => {}); // a late rejection after the cap is expected, not unhandled
    const cap = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${eventCapMs} ms`)), eventCapMs);
    });
    try {
      await Promise.race([insert, cap]);
    } catch (e) {
      log(`search event not recorded: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listSkills: authed(async (req, repo) => {
      const params = new URL(req.url).searchParams;
      const kind = params.get('kind');
      if (kind !== null && kind !== 'skill' && kind !== 'plugin') return fail(400, 'bad_request', 'kind must be skill or plugin');
      const integer = (key, fallback) => {
        const raw = params.get(key);
        if (raw === null) return fallback;
        if (!/^\d+$/.test(raw)) return null;
        const value = Number(raw);
        return Number.isSafeInteger(value) ? value : null;
      };
      const limit = integer('limit', CATALOG_DEFAULT_LIMIT);
      const offset = integer('offset', 0);
      if (limit === null || limit < 1 || limit > CATALOG_MAX_LIMIT) return fail(400, 'bad_request', `limit must be an integer in [1,${CATALOG_MAX_LIMIT}]`);
      if (offset === null || offset < 0) return fail(400, 'bad_request', 'offset must be a nonnegative safe integer');
      const tags = parseTagFilter(params);
      if (!tags) return fail(400, 'bad_request', TAG_FILTER_MESSAGE);
      const { skills, total } = await repo.listSkills({ kind: kind ?? undefined, tags, limit, offset });
      return json(200, { skills, total, limit, offset });
    }),

    search: authed(async (req, repo, ownerId) => {
      // A missing or invalid session gets a random id for this request, and the request is not logged.
      const validSession = sessionHeader(req);
      const sessionValid = validSession !== null;
      const sessionId = validSession ?? randomUUID();
      const rawPurpose = req.headers.get('x-headjack-purpose');
      const purpose = PURPOSES.has(rawPurpose) ? rawPurpose : 'manual';
      let input;
      if (req.method === 'POST') {
        const body = await readJsonObject(req, SEARCH_BODY_MAX_BYTES);
        if (body.tooLarge) return fail(413, 'payload_too_large', `body must be at most ${SEARCH_BODY_MAX_BYTES} bytes`);
        if (body.bad) return fail(400, 'bad_request', 'body must be a JSON object');
        const { q, k, kind, tags } = body.value;
        input = { q, k: k ?? 8, kind, tags };
      } else {
        const params = new URL(req.url).searchParams;
        input = { q: params.get('q') ?? '', k: Number(params.get('k') ?? '8'), kind: params.get('kind'), tags: rawTagFilter(params) };
      }
      const checked = searchParams(input);
      if (checked.error) return checked.error;
      const { q, k, kind, tags } = checked;
      const variant = await searchVariant(req, { ownerId, sessionId });
      const ranked = await rankSkills({ repo, embed, query: q, tags, k, kind, variant });
      const results = ranked.map(({ quality, ...row }) => row);
      if (purpose === 'suggest' && sessionValid && !overridden(req)) {
        await logExposure(repo, { sessionId, variant, q, topSlugs: results.map((r) => r.slug) });
      }
      return json(200, { results });
    }),

    // An install reported by the CLI. The session header is optional here; a failed insert still answers 204.
    installEvent: authed(async (req, repo) => {
      let body;
      try { body = await req.json(); } catch { return fail(400, 'bad_request', 'body must be JSON'); }
      const { slug, kind, source } = body ?? {};
      if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return fail(400, 'bad_request', 'invalid slug');
      if (kind !== 'skill' && kind !== 'plugin') return fail(400, 'bad_request', 'kind must be skill or plugin');
      if (!INSTALL_SOURCES.has(source)) return fail(400, 'bad_request', 'source must be suggest, plan or manual');
      try {
        await repo.logInstallEvent({ sessionId: sessionHeader(req), slug, kind, source });
      } catch (e) {
        log(`install event not recorded: ${e.message}`);
      }
      return new Response(null, { status: 204 });
    }),

    getSkill: authed(withSlug(async (req, repo, slug) => {
      const skill = await repo.getSkill(slug);
      return skill ? json(200, { skill }) : fail(404, 'not_found', `skill ${slug} not found`);
    })),

    download: authed(withSlug(async (req, repo, slug) => {
      const row = await repo.getTarball(slug);
      if (!row) return fail(404, 'not_found', `skill ${slug} not found`);
      if (row.kind === 'plugin' || row.plugin_slug) return fail(409, 'conflict', 'plugins are enabled via settings, not downloaded');
      if (!row.tarball) return fail(404, 'not_found', `skill ${slug} has no approved version`);
      return new Response(row.tarball, { status: 200, headers: { 'content-type': 'application/gzip', 'x-skill-sha256': row.sha256 } });
    })),

    versions: authed(withSlug(async (req, repo, slug) => {
      if (!(await repo.getSkill(slug))) return fail(404, 'not_found', `skill ${slug} not found`);
      return json(200, { versions: await repo.listVersions(slug) });
    })),

    reviews: authed(withSlug(async (req, repo, slug) => {
      if (!(await repo.getSkill(slug))) return fail(404, 'not_found', `skill ${slug} not found`);
      return json(200, { reviews: await repo.listReviews(slug) });
    })),

    publish: authed(async (req, repo) => {
      let form;
      try { form = await req.formData(); } catch { return fail(400, 'bad_request', 'expected multipart/form-data'); }
      let manifest;
      try { manifest = JSON.parse(String(form.get('manifest') ?? '')); } catch { return fail(400, 'bad_request', 'manifest must be JSON'); }
      const invalid = validateManifest(manifest);
      if (invalid) return fail(400, 'bad_request', invalid);
      const part = form.get('tarball');
      const tarball = part && typeof part !== 'string' ? Buffer.from(await part.arrayBuffer()) : null;
      const standalone = manifest.kind === 'skill' && !manifest.plugin_slug;
      if (standalone && manifest.status === 'approved' && !tarball) return fail(400, 'bad_request', 'approved standalone skills require a tarball');
      let files = null;
      if (tarball) {
        try { files = unpack(tarball); } catch (e) { return fail(400, 'bad_request', `invalid tarball: ${e.message}`); }
        const actual = hashFiles(files);
        if (actual !== manifest.sha256) return fail(400, 'hash_mismatch', `tarball hash ${actual} does not match manifest ${manifest.sha256}`);
      }
      // Fast path so a re-run of an import pays no LLM or embedding call; repo.publish's check stays the authority.
      if (await repo.versionExists(manifest.slug, manifest.sha256)) {
        return fail(409, 'conflict', `${manifest.slug}@${manifest.sha256.slice(0, 12)} already published`);
      }
      const approved = manifest.status === 'approved';
      // Plugin skills have no SKILL.md tarball: their manifest chunks stand in for the body.
      const body = standalone ? skillBody(files) : manifest.chunks.join('\n\n');
      const enrichment = approved && embed
        ? await tryEnrich(enrich, { name: manifest.name, description: manifest.description, body }, manifest.slug, enrichTimeoutMs, log)
        : null;
      let chunks = [];
      if (approved) {
        chunks = embed
          ? await embedChunks(manifest.chunks, enrichment?.queries ?? [], manifest.slug)
          : manifest.chunks.map((text) => ({ text, kind: 'content' }));
      }
      const tags = mergeTags(manifest.tags, enrichment?.tags);
      try {
        // Rejected versions store no tarball (spec §3); the upload was still hash-checked above.
        // queriesEs is null without an enrichment (timeout, failure, rejected version): on an approved version the
        // repo then clears queries_es_text along with the query chunks; a rejected version never touches it.
        const queriesEs = enrichment?.queries_es ?? null;
        return json(201, await repo.publish({ manifest: { ...manifest, tags }, tarball: approved ? tarball : null, chunks, queriesEs }));
      } catch (e) {
        if (e instanceof ConflictError) return fail(409, 'conflict', e.message);
        throw e;
      }
    }),

    updates: authed(async (req, repo) => {
      const grandfathered = new URL(req.url).searchParams.get('grandfathered') === '1';
      return json(200, { updates: await repo.listUpdates({ grandfathered }) });
    }),

    // Visits owners one by one: each owner's targets are read and marked through that owner's repo (RLS applies);
    // the network check runs between transactions. One GitHub response cache per run, shared by every target.
    // Event retention runs first, for every owner, each in its own try/catch: a failing owner or a slow upstream check
    // cannot stop it.
    cron: cronGuarded(async () => {
      const cache = new Map();
      const errors = [];
      let checked = 0;
      let updates = 0;
      const ownerIds = await listOwnerIds();
      for (const ownerId of ownerIds) {
        try {
          await repoFor(ownerId).deleteEventsOlderThan(EVENT_RETENTION_DAYS);
        } catch (e) {
          errors.push({ owner_id: ownerId, error: `event retention failed: ${e.message}` });
        }
      }
      for (const ownerId of ownerIds) {
        const repo = repoFor(ownerId);
        const targets = await repo.listUpstreamTargets();
        checked += targets.length;
        for (const t of targets) {
          try {
            const r = await checkUpstream(t, fetchImpl, env.GITHUB_TOKEN, cache);
            await repo.markUpstream(t.skill_id, r.latest, r.updateAvailable);
            if (r.updateAvailable) updates++;
          } catch (e) {
            errors.push({ skill_id: t.skill_id, url: t.url, error: e.message });
          }
        }
      }
      return json(200, { checked, updates, errors });
    }),
  };
}
