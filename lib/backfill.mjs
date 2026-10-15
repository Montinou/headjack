// Backfill jobs run by scripts/ against the vault DB. Dependencies (repo, enrich, embed) are injected.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseSkillMd } from './skillmd.mjs';
import { mergeTags } from './tags.mjs';
import { unpack } from './tar.mjs';

export const BACKFILL_CONCURRENCY = 4;

export function parseBackfillArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean' }, limit: { type: 'string' }, only: { type: 'string' }, force: { type: 'boolean' } },
  });
  let limit;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be an integer ≥ 1');
  }
  const only = (values.only ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { dryRun: Boolean(values['dry-run']), limit, only, force: Boolean(values.force) };
}

// Runs fn over items with at most `n` in flight.
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function readBody(repo, t, log) {
  if (t.kind !== 'skill' || t.plugin_slug) return ''; // plugins and plugin skills have no tarball
  try {
    const row = await repo.getTarball(t.slug);
    const f = row?.tarball ? unpack(Buffer.from(row.tarball)).find((x) => x.path === 'SKILL.md') : null;
    if (!f) throw new Error('no tarball or no SKILL.md');
    return parseSkillMd(f.data.toString('utf8')).body;
  } catch (e) {
    log(`${t.slug}: could not read SKILL.md (${e.message}); using only name and description`);
    return '';
  }
}

// Adds synthetic query chunks and tags to current versions that lack them, without creating new versions.
export async function enrichExisting({ repo, enrich, embed, log, dryRun = false, limit, only = [], force = false, concurrency = BACKFILL_CONCURRENCY }) {
  const targets = await repo.listEnrichmentTargets({ force, only });
  const work = limit ? targets.slice(0, limit) : targets;
  const out = { enriched: [], skipped: [], failed: [] };
  await pool(work, concurrency, async (t) => {
    try {
      const body = await readBody(repo, t, log);
      const { queries, queries_es: queriesEs, tags } = await enrich({ name: t.name, description: t.description, body });
      const merged = mergeTags(t.tags, tags);
      if (dryRun) {
        log(`${t.slug}  tags=${merged.join(',')}\n${queries.map((q) => `    · ${q}`).join('\n')}`);
        out.enriched.push(t.slug);
        return;
      }
      const vectors = await embed(queries);
      const chunks = queries.map((text, i) => ({ text, embedding: vectors[i], kind: 'query' }));
      if (await repo.addQueryChunks({ skillId: t.skill_id, versionId: t.version_id, chunks, tags: merged, queriesEs })) {
        out.enriched.push(t.slug);
        log(`ok    ${t.slug}  (${queries.length} queries, tags=${merged.join(',')})`);
      } else {
        out.skipped.push(t.slug);
        log(`skip  ${t.slug}  (the current version changed)`);
      }
    } catch (e) {
      out.failed.push({ slug: t.slug, reason: e.message });
      log(`FAIL  ${t.slug}  ${e.message}`);
    }
  });
  return out;
}

// --- Spanish query text backfill ---

// Counts over every current version (listQueriesEsTargets with force lists them all, each with has_text).
async function countQueriesEs(repo) {
  const rows = await repo.listQueriesEsTargets({ force: true, only: [] });
  return { total: rows.length, withText: rows.filter((r) => r.has_text).length };
}

// Fills skills.queries_es_text of current versions that have none (all of them with force), writing nothing else:
// no chunks, tags or English side. `enrichEs(skill)` returns { queries_es, usage }. A real run logs slugs and counts,
// never the generated queries; a dry run logs each slug's generated queries (synthetic text from the skill metadata)
// as a quality sample.
export async function backfillQueriesEs({ repo, enrichEs, log, dryRun = false, limit, only = [], force = false, concurrency = BACKFILL_CONCURRENCY }) {
  const before = await countQueriesEs(repo);
  const targets = await repo.listQueriesEsTargets({ force, only });
  const work = limit ? targets.slice(0, limit) : targets;
  const out = { before, after: before, filled: [], skipped: [], failed: [], usage: { inputTokens: 0, outputTokens: 0 } };
  await pool(work, concurrency, async (t) => {
    try {
      const body = await readBody(repo, t, log);
      const { queries_es: queriesEs, usage } = await enrichEs({ name: t.name, description: t.description, body });
      out.usage.inputTokens += usage?.inputTokens ?? 0;
      out.usage.outputTokens += usage?.outputTokens ?? 0;
      if (dryRun) {
        out.filled.push(t.slug);
        log(`dry   ${t.slug}  (${queriesEs.length} queries)\n${queriesEs.map((q) => `    · ${q}`).join('\n')}`);
        return;
      }
      if (await repo.setQueriesEs(t.skill_id, t.version_id, queriesEs.join(' '))) {
        out.filled.push(t.slug);
        log(`ok    ${t.slug}  (${queriesEs.length} queries)`);
      } else {
        out.skipped.push(t.slug);
        log(`skip  ${t.slug}  (no longer in the vault or the current version changed)`);
      }
    } catch (e) {
      out.failed.push({ slug: t.slug, reason: e.message });
      log(`FAIL  ${t.slug}  ${e.message}`);
    }
  });
  if (!dryRun) out.after = await countQueriesEs(repo);
  return out;
}

// --- Audit metadata import ---

const SLUG_RE = /^[A-Za-z0-9._@:-]{1,200}$/;
const AUDIT_VERDICTS = new Set(['VAULT', 'VAULT_AFTER_FIX']);
const SCORES = ['reuse', 'trigger', 'content', 'health'];

export function parseAuditJsonl(text) {
  const rows = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch (e) { errors.push(`line ${i + 1}: ${e.message}`); }
  });
  return { rows, errors };
}

// Sets skills.quality and merges suggested_tags for audited rows kept in the vault. The slug is the skill folder
// name (basename of `path`), as standalone skills are published under their folder name.
export async function importAudit({ repo, rows, log, now = () => new Date().toISOString() }) {
  const out = { updated: [], missing: [], ignored: 0, invalid: [] };
  const auditedAt = now();
  for (const row of rows) {
    if (!AUDIT_VERDICTS.has(row?.verdict)) { out.ignored++; continue; }
    const slug = typeof row.path === 'string' ? path.posix.basename(row.path) : '';
    const scoresOk = SCORES.every((k) => Number.isInteger(row[k]) && row[k] >= 0 && row[k] <= 3);
    if (!SLUG_RE.test(slug) || !scoresOk) {
      out.invalid.push(slug || JSON.stringify(row).slice(0, 80));
      log(`invalid  ${slug || '(no path)'}`);
      continue;
    }
    const quality = { reuse: row.reuse, trigger: row.trigger, content: row.content, health: row.health, verdict: row.verdict, audited_at: auditedAt };
    const tags = Array.isArray(row.suggested_tags) ? row.suggested_tags : [];
    if (await repo.setAuditMetadata(slug, quality, tags)) {
      out.updated.push(slug);
      log(`ok     ${slug}`);
    } else {
      out.missing.push(slug);
      log(`missing  ${slug} (not in the vault)`);
    }
  }
  return out;
}
