import { ENRICHMENT_VERSION } from './enrich-prompt.mjs';
import { ConflictError } from './errors.mjs';
import { spanishTerms } from './spanish.mjs';
import { mergeTags, tagsText } from './tags.mjs';

const toVector = (arr) => `[${arr.join(',')}]`;
// skills.queries_es_text for a list of Spanish enrichment queries; null (no enrichment) stores ''.
const spanishText = (queriesEs) => (queriesEs ?? []).join(' ');
// skills.enrichment_v for a queries_es_text value: the current prompt version for text, null for '' (spec §6.3).
const enrichmentV = (text) => (text === '' ? null : ENRICHMENT_VERSION);
const MAX_TEXT_TERMS = 20;
const MIN_TERM_LENGTH = 2;

// `db` is the transaction handle from withOwner (lib/db.mjs): every statement runs as headjack_app inside one
// transaction pinned to one owner, so RLS scopes each query and an error rolls back everything the call wrote.
// owner_id is never passed: the column defaults to app.current_owner_id() and the policies check it.
export function createRepo(db) {
  const q = (text, params) => db.query(text, params).then((r) => r.rows);

  return {
    // Count and page share one statement snapshot. The aggregate always returns an envelope, even when the page
    // is empty; browse deliberately retains skills with no current approved version.
    async listSkills({ kind, tags, limit, offset }) {
      const [row] = await q(
        `with filtered as (
           select s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality,
                  coalesce(u.update_available, false) as update_available,
                  coalesce(v.status = 'approved', false) as has_approved_version
             from skills s
             left join versions v on v.id = s.current_version_id
             left join upstream u on u.skill_id = s.id
            where ($1::text is null or s.kind = $1) and s.tags @> $2::text[]
         ), page as (
           select * from filtered order by name, slug limit $3 offset $4
         )
         select coalesce((select jsonb_agg(to_jsonb(p) order by p.name, p.slug) from page p), '[]'::jsonb) as skills,
                (select count(*) from filtered) as total`,
        [kind ?? null, tags, limit, offset],
      );
      return { skills: row.skills, total: Number(row.total) };
    },

    // Best chunk per skill, of either kind: a synthetic query chunk wins when the request is phrased like it.
    // `tags`: only skills carrying every one of them.
    async searchVector(embedding, limit, tags = []) {
      const byTags = tags.length ? 'where s.tags @> $3::text[]' : '';
      const rows = await q(
        `select c.skill_id, max(1 - (c.embedding <=> $1::vector)) as sim
           from chunks c join skills s on s.id = c.skill_id and c.version_id = s.current_version_id
          ${byTags}
          group by c.skill_id order by sim desc limit $2`,
        tags.length ? [toVector(embedding), limit, tags] : [toVector(embedding), limit],
      );
      return rows.map((r) => ({ id: Number(r.skill_id), sim: Number(r.sim) }));
    },

    // `bilingual`: a skill also matches through its Spanish queries (fts_es); its rank is the greater ts_rank.
    async searchText(query, limit, tags = [], { bilingual = false } = {}) {
      // OR the words (plainto_tsquery ANDs them, so one unmatched word drops a relevant skill).
      // Only letters/digits/marks reach to_tsquery, so no tsquery operator can be injected.
      // 'english' stems ("models" ~ "model") and drops stop words; 1-char terms are noise.
      const terms = query
        .split(/[^\p{L}\p{N}\p{M}]+/u)
        .filter((t) => t.length >= MIN_TERM_LENGTH)
        .slice(0, MAX_TEXT_TERMS);
      if (!terms.length) return [];
      // No Spanish term left (only filler words): the Spanish side is skipped and the query is the english-only one.
      const es = bilingual ? spanishTerms(terms) : [];
      if (es.length) {
        const byTagsEs = tags.length ? 'and tags @> $4::text[]' : '';
        const rows = await q(
          `select id from skills
            where current_version_id is not null
              and (fts @@ to_tsquery('english', $1) or fts_es @@ to_tsquery('spanish', $2)) ${byTagsEs}
            order by greatest(ts_rank(fts, to_tsquery('english', $1)), ts_rank(fts_es, to_tsquery('spanish', $2))) desc limit $3`,
          tags.length ? [terms.join(' | '), es.join(' | '), limit, tags] : [terms.join(' | '), es.join(' | '), limit],
        );
        return rows.map((r) => Number(r.id));
      }
      const byTags = tags.length ? 'and tags @> $3::text[]' : '';
      const rows = await q(
        `select id from skills
          where current_version_id is not null and fts @@ to_tsquery('english', $1) ${byTags}
          order by ts_rank(fts, to_tsquery('english', $1)) desc limit $2`,
        tags.length ? [terms.join(' | '), limit, tags] : [terms.join(' | '), limit],
      );
      return rows.map((r) => Number(r.id));
    },

    async getSkillsByIds(ids) {
      if (!ids.length) return [];
      return q(
        `select s.id::int as id, s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality,
                v.review_notes, coalesce(u.update_available, false) as update_available
           from skills s left join upstream u on u.skill_id = s.id
           left join versions v on v.id = s.current_version_id
          where s.id = any($1::bigint[])`,
        [ids],
      );
    },

    async getSkill(slug) {
      const [row] = await q(
        `select s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality, s.source_path,
                src.kind as source_kind, src.url as source_url, src.default_ref,
                v.commit_sha, v.sha256, v.size, v.reviewed_at, v.review_notes, v.scan_flags,
                coalesce(u.update_available, false) as update_available, u.latest_commit,
                s.queries_es_text, s.enrichment_v
           from skills s
           left join sources src on src.id = s.source_id
           left join versions v on v.id = s.current_version_id
           left join upstream u on u.skill_id = s.id
          where s.slug = $1`,
        [slug],
      );
      return row ?? null;
    },

    async getTarball(slug) {
      const [row] = await q(
        `select s.kind, s.plugin_slug, v.sha256, b.data as tarball
           from skills s
           left join versions v on v.id = s.current_version_id
           left join blobs b on b.sha256 = v.blob_sha256
          where s.slug = $1`,
        [slug],
      );
      return row ?? null;
    },

    async listMcpSkills({ tag = null, kind = null, after = null, limit = 51 } = {}) {
      return q(
        `select s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality, s.source_path,
                src.kind as source_kind, src.url as source_url, src.default_ref,
                v.commit_sha, v.sha256, v.size, v.reviewed_at, v.review_notes, v.scan_flags,
                coalesce(u.update_available, false) as update_available, u.latest_commit
           from skills s
           left join sources src on src.id = s.source_id
           left join versions v on v.id = s.current_version_id
           left join upstream u on u.skill_id = s.id
          where ($1::text is null or $1 = any(s.tags))
            and ($2::text is null or s.kind = $2)
            and ($3::text is null or s.slug collate "C" > $3::text collate "C")
          order by s.slug collate "C" asc limit $4`,
        [tag, kind, after, limit],
      );
    },

    async consumeMcpSearchBudget() {
      const [row] = await q('select allowed, retry_after from app.consume_mcp_search_budget()');
      return { allowed: row.allowed, retryAfter: row.retry_after };
    },

    // Metadata and archive share one statement snapshot, including a concurrent current-version change.
    async getMcpSkill(slug) {
      const [row] = await q(
        `select s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality, s.source_path,
                src.kind as source_kind, src.url as source_url, src.default_ref,
                v.commit_sha, v.sha256, v.size, v.reviewed_at, v.review_notes, v.scan_flags,
                coalesce(u.update_available, false) as update_available, u.latest_commit,
                s.queries_es_text, s.enrichment_v, b.data as tarball
           from skills s
           left join sources src on src.id = s.source_id
           left join versions v on v.id = s.current_version_id
           left join upstream u on u.skill_id = s.id
           left join blobs b on b.sha256 = v.blob_sha256
          where s.slug = $1`,
        [slug],
      );
      if (!row) return null;
      const { tarball, ...metadata } = row;
      return { metadata, tarball };
    },

    async listVersions(slug) {
      return q(
        `select v.id::int as id, v.commit_sha, v.sha256, v.size, v.status, v.reviewed_at, v.review_notes, v.scan_flags,
                coalesce(v.id = s.current_version_id, false) as current
           from versions v join skills s on s.id = v.skill_id
          where s.slug = $1 order by v.reviewed_at desc, v.id desc`,
        [slug],
      );
    },

    // Review audit history for a skill: every version ever reviewed (approved or rejected), newest first.
    async listReviews(slug) {
      return q(
        `select v.commit_sha, v.status, v.reviewed_at, v.review_notes, v.sha256,
                coalesce(v.id = s.current_version_id, false) as current
           from versions v join skills s on s.id = v.skill_id
          where s.slug = $1 order by v.reviewed_at desc, v.id desc`,
        [slug],
      );
    },

    // Cheap pre-check for the publish handler; the transactional check inside publish stays the authority.
    async versionExists(slug, sha256) {
      const rows = await q(
        `select 1 from versions v join skills s on s.id = v.skill_id
          where s.slug = $1 and v.sha256 = $2 limit 1`,
        [slug, sha256],
      );
      return rows.length > 0;
    },

    // `queriesEs` (string[] | null): the enrichment's Spanish queries. Only an approved version writes them to
    // queries_es_text, in the same statement that makes it current; a rejected version never touches the text.
    async publish({ manifest: m, tarball, chunks, queriesEs = null }) {
      try {
        let sourceId = null;
        if (m.source) {
          const [src] = await q(
            `insert into sources (kind, url, default_ref) values ($1, $2, coalesce($3, 'HEAD'))
             on conflict (owner_id, kind, url) do update set default_ref = excluded.default_ref
             returning id`,
            [m.source.kind, m.source.url ?? null, m.source.default_ref ?? null],
          );
          sourceId = src.id;
        }
        const existing = await q('select id from skills where slug = $1 for update', [m.slug]);
        let skillId;
        const tags = m.tags ?? [];
        const fields = [m.name, m.description, m.kind, m.plugin_slug ?? null, sourceId, m.source_path ?? null, tags, tagsText(tags)];
        if (existing.length) {
          skillId = existing[0].id;
          const dup = await q('select 1 from versions where skill_id = $1 and sha256 = $2', [skillId, m.sha256]);
          if (dup.length) throw new ConflictError(`${m.slug}@${m.sha256.slice(0, 12)} already published`);
          if (m.status === 'approved') {
            await q(
              `update skills set name = $2, description = $3, kind = $4, plugin_slug = $5, source_id = $6, source_path = $7, tags = $8, tags_text = $9
                where id = $1`,
              [skillId, ...fields],
            );
          }
        } else {
          const [row] = await q(
            `insert into skills (slug, name, description, kind, plugin_slug, source_id, source_path, tags, tags_text)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
            [m.slug, ...fields],
          );
          skillId = row.id;
        }
        // Tarballs are content-addressed and shared across owners: app.put_blob hashes the bytes in the database,
        // stores them once and returns the key.
        let blobSha256 = null;
        if (tarball) {
          const [blob] = await q('select app.put_blob($1) as sha256', [tarball]);
          blobSha256 = blob.sha256;
        }
        const [v] = await q(
          `insert into versions (skill_id, commit_sha, sha256, blob_sha256, size, status, review_notes, scan_flags)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning id`,
          [skillId, m.commit_sha ?? null, m.sha256, blobSha256, tarball ? tarball.length : null,
            m.status, m.review_notes ?? null, JSON.stringify(m.scan_flags ?? [])],
        );
        const versionId = v.id;
        if (m.status === 'approved') {
          const es = spanishText(queriesEs);
          await q('update skills set current_version_id = $2, queries_es_text = $3, enrichment_v = $4 where id = $1', [skillId, versionId, es, enrichmentV(es)]);
          await q('delete from chunks where skill_id = $1', [skillId]);
          for (const c of chunks) {
            await q(
              'insert into chunks (skill_id, version_id, text, embedding, kind) values ($1, $2, $3, $4::vector, $5)',
              [skillId, versionId, c.text, toVector(c.embedding), c.kind ?? 'content'],
            );
          }
          await q(
            `insert into upstream (skill_id, latest_commit, checked_at, update_available) values ($1, $2, now(), false)
             on conflict (skill_id) do update set latest_commit = excluded.latest_commit, checked_at = now(), update_available = false`,
            [skillId, m.commit_sha ?? null],
          );
        } else {
          // A rejected review changes the upstream baseline: clear any pending notice now, so `updates` reflects it
          // immediately instead of waiting for the next weekly cron.
          await q('update upstream set update_available = false where skill_id = $1', [skillId]);
        }
        return { skillId: Number(skillId), versionId: Number(versionId) };
      } catch (e) {
        // unique_violation, e.g. two concurrent first publishes of the same slug. withOwner rolls back.
        if (e?.code === '23505') throw new ConflictError(`${m.slug} was published concurrently`);
        throw e;
      }
    },

    // Backfill: current versions that have no synthetic query chunks yet (all current versions with force).
    async listEnrichmentTargets({ force = false, only = [] } = {}) {
      return q(
        `select s.id::int as skill_id, s.current_version_id::int as version_id, s.slug, s.name, s.description,
                s.kind, s.plugin_slug, s.tags
           from skills s join versions v on v.id = s.current_version_id
          where ($1::boolean or not exists (
                  select 1 from chunks c where c.skill_id = s.id and c.version_id = s.current_version_id and c.kind = 'query'))
            and (cardinality($2::text[]) = 0 or s.slug = any($2::text[]))
          order by s.slug`,
        [force, only],
      );
    },

    // Replaces the query chunks of a version, the skill tags and queries_es_text, in one transaction. Returns false
    // (writing nothing) when a newer version became current in the meantime.
    async addQueryChunks({ skillId, versionId, chunks, tags, queriesEs = null }) {
      const cur = await q('select current_version_id from skills where id = $1 for update', [skillId]);
      if (Number(cur[0]?.current_version_id) !== Number(versionId)) return false;
      await q("delete from chunks where skill_id = $1 and version_id = $2 and kind = 'query'", [skillId, versionId]);
      for (const c of chunks) {
        await q(
          'insert into chunks (skill_id, version_id, text, embedding, kind) values ($1, $2, $3, $4::vector, $5)',
          [skillId, versionId, c.text, toVector(c.embedding), 'query'],
        );
      }
      const es = spanishText(queriesEs);
      await q('update skills set tags = $2, tags_text = $3, queries_es_text = $4, enrichment_v = $5 where id = $1', [skillId, tags, tagsText(tags), es, enrichmentV(es)]);
      return true;
    },

    // Spanish backfill: current versions whose queries_es_text is empty (all current versions with force; with stale,
    // those whose enrichment_v is null or older than ENRICHMENT_VERSION).
    async listQueriesEsTargets({ force = false, only = [], stale = false } = {}) {
      return q(
        `select s.id::int as skill_id, s.current_version_id::int as version_id, s.slug, s.name, s.description,
                s.kind, s.plugin_slug, s.queries_es_text <> '' as has_text
           from skills s join versions v on v.id = s.current_version_id
          where ($1::boolean
                 or ($3::boolean and (s.enrichment_v is null or s.enrichment_v < $4::int))
                 or (not $3::boolean and s.queries_es_text = ''))
            and (cardinality($2::text[]) = 0 or s.slug = any($2::text[]))
          order by s.slug`,
        [force, only, stale, ENRICHMENT_VERSION],
      );
    },

    // Writes queries_es_text (and its enrichment_v) of one skill and nothing else. Returns false (writing nothing) when
    // no visible skill has that id or versionId is no longer its current version.
    async setQueriesEs(skillId, versionId, text) {
      const rows = await q(
        'update skills set queries_es_text = $3, enrichment_v = $4 where id = $1 and current_version_id = $2 returning id',
        [skillId, versionId, text, enrichmentV(text)],
      );
      return rows.length > 0;
    },

    // Audit import: quality scores replace the previous ones; suggested tags are merged into the existing tags.
    // Returns false when the slug is not in the vault.
    async setAuditMetadata(slug, quality, suggestedTags) {
      const found = await q('select id, tags from skills where slug = $1 for update', [slug]);
      if (!found.length) return false;
      const { id, tags } = found[0];
      const merged = mergeTags(tags, suggestedTags);
      await q(
        'update skills set quality = $2::jsonb, tags = $3, tags_text = $4 where id = $1',
        [id, JSON.stringify(quality), merged, tagsText(merged)],
      );
      return true;
    },

    async listUpdates({ grandfathered = false } = {}) {
      if (grandfathered) {
        return q(
          `select s.slug, s.name, v.reviewed_at
             from skills s join versions v on v.id = s.current_version_id
            where v.review_notes like 'grandfathered:%' order by s.slug`,
        );
      }
      return q(
        `select s.slug, s.name, v.commit_sha as current_commit, r.commit_sha as reviewed_commit,
                u.latest_commit, u.checked_at, src.url as source_url, s.source_path
           from skills s
           join upstream u on u.skill_id = s.id
           join versions v on v.id = s.current_version_id
           join lateral (
             select commit_sha from versions where skill_id = s.id and commit_sha is not null
              order by reviewed_at desc, id desc limit 1
           ) r on true
           left join sources src on src.id = s.source_id
          where u.update_available order by s.slug`,
      );
    },

    // Upstream targets are baselined on the latest REVIEWED version that has a commit_sha (approved or rejected;
    // a locally-reviewed rejection with no commit_sha must never clobber the baseline), not on
    // skills.current_version_id: a reviewed-and-rejected upstream update must stop being flagged every week.
    // Still only skills with a current approved version are targets — a skill with only rejected versions is not
    // one, matching listUpdates. The lateral is a LEFT join: a grandfathered import (no reviewed version has a
    // commit_sha) is still a target, with commit_sha null, exactly as before this baseline change.
    async listUpstreamTargets() {
      return q(
        `select s.id::int as skill_id, src.kind, src.url, src.default_ref, v.commit_sha, s.source_path, u.checked_at
           from skills s
           join sources src on src.id = s.source_id
           left join upstream u on u.skill_id = s.id
           left join lateral (
             select commit_sha from versions where skill_id = s.id and commit_sha is not null
              order by reviewed_at desc, id desc limit 1
           ) v on true
          where src.kind in ('github', 'git') and src.url is not null and s.current_version_id is not null`,
      );
    },

    async markUpstream(skillId, latestCommit, updateAvailable) {
      await q(
        `insert into upstream (skill_id, latest_commit, checked_at, update_available) values ($1, $2, now(), $3)
         on conflict (skill_id) do update
           set latest_commit = excluded.latest_commit, checked_at = now(), update_available = excluded.update_available`,
        [skillId, latestCommit, updateAvailable],
      );
    },

    // Exposure of a `suggest` search: only the HMAC of the query is stored, never its text.
    async logSearchEvent({ sessionId, variant, queryHmac, topSlugs }) {
      await q(
        'insert into search_events (session_id, variant, query_hmac, top_slugs) values ($1, $2, $3, $4::text[])',
        [sessionId, variant, queryHmac, topSlugs],
      );
    },

    async logInstallEvent({ sessionId = null, slug, kind, source }) {
      await q(
        'insert into install_events (session_id, slug, kind, source) values ($1, $2, $3, $4)',
        [sessionId, slug, kind, source],
      );
    },

    // Retention: both event tables, one statement. Returns the total number of rows deleted.
    async deleteEventsOlderThan(days) {
      const [row] = await q(
        `with s as (delete from search_events where created_at < now() - make_interval(days => $1::int) returning 1),
              i as (delete from install_events where created_at < now() - make_interval(days => $1::int) returning 1)
         select (select count(*) from s)::int + (select count(*) from i)::int as deleted`,
        [days],
      );
      return Number(row.deleted);
    },

    // One row per variant in search_events. A conversion is a `suggest` install with a session whose slug is in the
    // top_slugs of an exposure of the same session in the `windowMinutes` before it; it counts once, for the latest
    // such exposure's variant.
    async conversionsByVariant({ windowMinutes = 30 } = {}) {
      const rows = await q(
        `with conv as (
           select distinct on (i.id) i.id, e.variant
             from install_events i
             join search_events e
               on e.session_id = i.session_id
              and i.created_at > e.created_at
              and i.created_at <= e.created_at + make_interval(mins => $1::int)
              and i.slug = any(e.top_slugs)
            where i.source = 'suggest' and i.session_id is not null
            order by i.id, e.created_at desc, e.id desc
         )
         select x.variant, x.exposures, coalesce(c.conversions, 0)::int as conversions
           from (select variant, count(*)::int as exposures from search_events group by variant) x
           left join (select variant, count(*)::int as conversions from conv group by variant) c on c.variant = x.variant
          order by x.variant`,
        [windowMinutes],
      );
      return rows.map((r) => ({ variant: r.variant, exposures: Number(r.exposures), conversions: Number(r.conversions) }));
    },
  };
}

export const REPO_METHODS = Object.freeze(Object.keys(createRepo({ query: async () => ({ rows: [] }) })));

// A repo whose every method runs in its own withOwner transaction for `ownerId`. Handlers and scripts use this, so a
// slow step between two calls (enrichment, embedding, a network fetch) never holds a transaction open.
export function repoForOwner(withOwner, ownerId) {
  return Object.fromEntries(
    REPO_METHODS.map((name) => [name, (...args) => withOwner(ownerId, (db) => createRepo(db)[name](...args))]),
  );
}
