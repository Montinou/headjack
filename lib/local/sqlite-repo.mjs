// The repository methods the handlers and the local `updates` reach, over the SQLite vault (schema.mjs). Names,
// arguments and returned fields match lib/repo.mjs, normalized so the JSON the handlers send is identical: plain
// objects, true/false booleans, parsed tags/scan_flags/quality, ISO-8601 UTC timestamps. One implicit owner.
import { ConflictError } from '../errors.mjs';
import { tagsText } from '../tags.mjs';
import { collapseInstalls } from '../rank.mjs';
import { reviewOf } from '../review-status.mjs';
import { FTS_TOKENIZE } from './schema.mjs';

const MAX_TEXT_TERMS = 24;
const MIN_TERM_LENGTH = 2;
const SIGNAL_CANDIDATES = 50;
const MAX_MATCHED_TERMS = 12;
// Fusion tie order. Only 'en' (skill_docs) is queried today; 'es' and 'en-gloss' are accepted and contribute nothing.
const SIGNAL_TABLES = ['en', 'es', 'en-gloss'];
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const JSON_FIELDS = ['tags', 'scan_flags', 'quality'];
const BOOLEAN_FIELDS = ['update_available', 'current', 'has_approved_version'];

// node:sqlite rows have a null prototype, integers for booleans and JSON text for arrays.
function normalize(row) {
  if (!row) return null;
  const out = { ...row };
  for (const k of JSON_FIELDS) if (typeof out[k] === 'string') out[k] = JSON.parse(out[k]);
  for (const k of BOOLEAN_FIELDS) if (k in out) out[k] = Boolean(out[k]);
  if (out.tarball instanceof Uint8Array) out.tarball = Buffer.from(out.tarball.buffer, out.tarball.byteOffset, out.tarball.byteLength);
  return out;
}

const now = () => new Date().toISOString();

// The query's words for an FTS5 match: runs of letters, digits and marks, at least MIN_TERM_LENGTH long, the first
// MAX_TEXT_TERMS of them. Callers quote each one so no FTS5 syntax can be injected.
export function searchTerms(query) {
  return query
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length >= MIN_TERM_LENGTH)
    .slice(0, MAX_TEXT_TERMS);
}

// Fuses per-table signal rows: per skill the best table_rank wins, ties go to the earlier table in SIGNAL_TABLES (so the
// order of `lists` never matters), then the lower bm25. Results are ordered the same way.
const signalTableIndex = (r) => SIGNAL_TABLES.indexOf(r.fts_table);
const signalOrder = (a, b) => a.table_rank - b.table_rank || signalTableIndex(a) - signalTableIndex(b) || a.bm25 - b.bm25;
export function fuseSignals(lists) {
  const best = new Map();
  for (const rows of lists) {
    for (const r of rows) {
      const seen = best.get(r.id);
      if (!seen || signalOrder(r, seen) < 0) best.set(r.id, r);
    }
  }
  return [...best.values()].sort(signalOrder);
}

// The baseline commit: the newest reviewed version (approved or rejected) that has one.
const BASELINE_COMMIT = `(select commit_sha from versions where skill_id = s.id and commit_sha is not null
                           order by reviewed_at desc, id desc limit 1)`;

export function createSqliteRepo(db) {
  const all = (sql, ...params) => db.prepare(sql).all(...params).map(normalize);
  const get = (sql, ...params) => normalize(db.prepare(sql).get(...params));
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  // Every write takes the write lock up front (BEGIN IMMEDIATE), so it waits under busy_timeout instead of failing
  // part way through.
  function write(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      // SQLite may already have rolled back on its own (e.g. a full disk); a second ROLLBACK would hide `e`.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }

  // One table's candidates, ranked within the table. Equal scores keep publish order (s.id), so the install kept by
  // collapseInstalls is deterministic.
  function signalsForTable(table, terms) {
    if (!terms.length) return [];
    const rows = collapseInstalls(all(
      `select s.id, s.slug, s.name, s.plugin_slug, bm25(skill_docs, 4, 3, 2, 1) as score
         from skill_docs join skills s on s.id = skill_docs.rowid
        where skill_docs match ? and s.current_version_id is not null
        order by score, s.id limit ?`,
      terms.map((t) => `"${t}"`).join(' OR '), SIGNAL_CANDIDATES,
    ));
    return rows.map((r, i) => {
      const top = i === 0;
      return {
        id: r.id, slug: r.slug, name: r.name, plugin_slug: r.plugin_slug, alternatives: r.alternatives,
        fts_table: table, table_rank: i + 1, bm25: r.score,
        bm25_gap: top && rows.length > 1 ? rows[1].score - r.score : null,
        matched_terms: top ? matchedTerms(terms, r.id) : null,
      };
    });
  }

  // The number of distinct tokens among the first MAX_MATCHED_TERMS that match the skill_docs row, one MATCH per token.
  // Terms are tokenized with skill_docs' own tokenizer (porter stemming, case and diacritic folding), so "tomato" and
  // "Tomatoes" count once; each token is probed with the first term that produced it.
  function matchedTerms(terms, rowid) {
    const probe = db.prepare('select 1 as found from skill_docs where skill_docs match ? and rowid = ?');
    return distinctTokenTerms(terms).filter((t) => probe.get(`"${t}"`, rowid)).length;
  }

  // A temp FTS5 table (allowed on a read-only connection) tokenizes the terms; fts5vocab lists the tokens per row.
  let tokenizer = null;
  function distinctTokenTerms(terms) {
    if (!tokenizer) {
      db.exec(`create virtual table if not exists temp.headjack_signal_terms using fts5(term, tokenize='${FTS_TOKENIZE}')`);
      db.exec('create virtual table if not exists temp.headjack_signal_tokens using fts5vocab(temp, headjack_signal_terms, instance)');
      tokenizer = {
        insert: db.prepare('insert into temp.headjack_signal_terms (rowid, term) values (?, ?)'),
        tokens: db.prepare('select doc, term from temp.headjack_signal_tokens order by doc, offset'),
      };
    }
    try {
      terms.forEach((t, i) => tokenizer.insert.run(i + 1, t));
      const byTerm = new Map();
      for (const { doc, term } of tokenizer.tokens.all()) byTerm.set(doc, [...(byTerm.get(doc) ?? []), term]);
      const seen = new Set();
      const out = [];
      terms.forEach((t, i) => {
        const key = (byTerm.get(i + 1) ?? []).join(' ');
        if (!key || seen.has(key) || out.length >= MAX_MATCHED_TERMS) return;
        seen.add(key);
        out.push(t);
      });
      return out;
    } finally {
      db.exec('delete from temp.headjack_signal_terms');
    }
  }

  return {
    // The catalog, ordered by name then slug; `total` counts the filtered rows before paging. Like Postgres, browse keeps a
    // skill with no current approved version. `tags`: only skills carrying every one of them.
    async listSkills({ kind, tags, limit, offset }) {
      const where = `(? is null or s.kind = ?)
            and not exists (select 1 from json_each(?) t where t.value not in (select value from json_each(s.tags)))`;
      const args = [kind ?? null, kind ?? null, JSON.stringify(tags ?? [])];
      const skills = all(
        `select s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality,
                coalesce(u.update_available, 0) as update_available,
                coalesce(v.status = 'approved', 0) as has_approved_version
           from skills s
           left join versions v on v.id = s.current_version_id
           left join upstream u on u.skill_id = s.id
          where ${where}
          order by s.name, s.slug limit ? offset ?`,
        ...args, limit, offset,
      );
      const { total } = get(`select count(*) as total from skills s where ${where}`, ...args);
      return { skills, total };
    },

    // The query's words, quoted (so no FTS5 syntax can be injected) and ORed; ranked by bm25 over name, description,
    // tags and body. `tags`: only skills carrying every one of them.
    async searchText(query, limit, tags = []) {
      const terms = searchTerms(query);
      if (!terms.length) return [];
      const match = terms.map((t) => `"${t}"`).join(' OR ');
      const rows = all(
        `select s.id from skill_docs join skills s on s.id = skill_docs.rowid
          where skill_docs match ? and s.current_version_id is not null
            and not exists (select 1 from json_each(?) t where t.value not in (select value from json_each(s.tags)))
          order by bm25(skill_docs, 4, 3, 2, 1) limit ?`,
        match, JSON.stringify(tags), limit,
      );
      return rows.map((r) => r.id);
    },

    // Keyword signals for suggestions, best first. Each table is ranked on its own (bm25 is not comparable across
    // tables): duplicate installs collapse first, then the rank-1 row gets the bm25 gap to rank 2 (null with one hit)
    // and the number of distinct query tokens it matches (at most 12); other rows get null for both. Per skill the best table_rank
    // wins (ties in SIGNAL_TABLES order, then bm25), and `limit` truncates only after all of that.
    async searchSignals(query, { limit = 5, tables = ['en'], glossaryTerms = [] } = {}) {
      void glossaryTerms; // for the 'en-gloss' table, not built yet
      for (const t of tables) if (!SIGNAL_TABLES.includes(t)) throw new Error(`unknown search table: ${t}`);
      const perTable = tables.includes('en') ? [signalsForTable('en', searchTerms(query))] : [];
      const fused = fuseSignals(perTable).slice(0, limit);
      if (!fused.length) return [];
      const byId = new Map(all(
        `select s.id, s.description, s.kind, s.tags, v.review_notes
           from skills s join versions v on v.id = s.current_version_id
          where s.id in (select value from json_each(?))`,
        JSON.stringify(fused.map((r) => r.id)),
      ).map((r) => [r.id, r]));
      return fused.map((r) => {
        const row = byId.get(r.id);
        return {
          id: r.id, slug: r.slug, name: r.name, description: row.description, kind: row.kind, plugin_slug: r.plugin_slug,
          tags: row.tags, review: reviewOf(row.review_notes), ...(r.alternatives ? { alternatives: r.alternatives } : {}),
          fts_table: r.fts_table, table_rank: r.table_rank, bm25: r.bm25, bm25_gap: r.bm25_gap,
          matched_terms: r.matched_terms,
        };
      });
    },

    async getSkillsByIds(ids) {
      if (!ids.length) return [];
      return all(
        `select s.id, s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality,
                v.review_notes, coalesce(u.update_available, 0) as update_available
           from skills s left join upstream u on u.skill_id = s.id
           left join versions v on v.id = s.current_version_id
          where s.id in (select value from json_each(?))`,
        JSON.stringify(ids),
      );
    },

    async getSkill(slug) {
      // queries_es_text and enrichment_v are fixed until the local Spanish index lands (Phase 7).
      return get(
        `select s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality, s.source_path,
                src.kind as source_kind, src.url as source_url, src.default_ref,
                v.commit_sha, v.sha256, v.size, v.reviewed_at, v.review_notes, v.scan_flags,
                coalesce(u.update_available, 0) as update_available, u.latest_commit,
                '' as queries_es_text, null as enrichment_v
           from skills s
           left join sources src on src.id = s.source_id
           left join versions v on v.id = s.current_version_id
           left join upstream u on u.skill_id = s.id
          where s.slug = ?`,
        slug,
      );
    },

    async getTarball(slug) {
      return get(
        `select s.kind, s.plugin_slug, v.sha256, v.tarball
           from skills s left join versions v on v.id = s.current_version_id
          where s.slug = ?`,
        slug,
      );
    },

    async listVersions(slug) {
      return all(
        `select v.id, v.commit_sha, v.sha256, v.size, v.status, v.reviewed_at, v.review_notes, v.scan_flags,
                coalesce(v.id = s.current_version_id, 0) as current
           from versions v join skills s on s.id = v.skill_id
          where s.slug = ? order by v.reviewed_at desc, v.id desc`,
        slug,
      );
    },

    async listReviews(slug) {
      return all(
        `select v.commit_sha, v.status, v.reviewed_at, v.review_notes, v.sha256,
                coalesce(v.id = s.current_version_id, 0) as current
           from versions v join skills s on s.id = v.skill_id
          where s.slug = ? order by v.reviewed_at desc, v.id desc`,
        slug,
      );
    },

    async versionExists(slug, sha256) {
      return Boolean(get(
        'select 1 as found from versions v join skills s on s.id = v.skill_id where s.slug = ? and v.sha256 = ? limit 1',
        slug, sha256,
      ));
    },

    // `chunks`: { text, kind, embedding? }; the embedding is ignored. `queriesEs` is accepted for the shared signature
    // and not stored: local search has no Spanish branch.
    async publish({ manifest: m, tarball, chunks }) {
      try {
        return write(() => {
          let sourceId = null;
          if (m.source) {
            sourceId = get(
              `insert into sources (kind, url, default_ref) values (?, ?, coalesce(?, 'HEAD'))
               on conflict (kind, coalesce(url, '')) do update set default_ref = excluded.default_ref
               returning id`,
              m.source.kind, m.source.url ?? null, m.source.default_ref ?? null,
            ).id;
          }
          const tags = m.tags ?? [];
          const fields = [m.name, m.description, m.kind, m.plugin_slug ?? null, sourceId, m.source_path ?? null, JSON.stringify(tags)];
          const existing = get('select id from skills where slug = ?', m.slug);
          let skillId;
          if (existing) {
            skillId = existing.id;
            if (get('select 1 as found from versions where skill_id = ? and sha256 = ?', skillId, m.sha256)) {
              throw new ConflictError(`${m.slug}@${m.sha256.slice(0, 12)} already published`);
            }
            if (m.status === 'approved') {
              run(
                `update skills set name = ?, description = ?, kind = ?, plugin_slug = ?, source_id = ?, source_path = ?, tags = ?
                  where id = ?`,
                ...fields, skillId,
              );
            }
          } else {
            skillId = get(
              `insert into skills (slug, name, description, kind, plugin_slug, source_id, source_path, tags)
               values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
              m.slug, ...fields,
            ).id;
          }
          const versionId = get(
            `insert into versions (skill_id, commit_sha, sha256, size, status, reviewed_at, review_notes, scan_flags, tarball)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
            skillId, m.commit_sha ?? null, m.sha256, tarball ? tarball.length : null, m.status, now(),
            m.review_notes ?? null, JSON.stringify(m.scan_flags ?? []), tarball ?? null,
          ).id;
          if (m.status === 'approved') {
            run('update skills set current_version_id = ? where id = ?', versionId, skillId);
            const body = chunks.filter((c) => (c.kind ?? 'content') === 'content').map((c) => c.text).join('\n');
            run('delete from skill_docs where rowid = ?', skillId);
            run(
              'insert into skill_docs (rowid, name, description, tags, body) values (?, ?, ?, ?, ?)',
              skillId, m.name, m.description, tagsText(tags), body,
            );
            run(
              `insert into upstream (skill_id, latest_commit, checked_at, update_available) values (?, ?, ?, 0)
               on conflict (skill_id) do update
                 set latest_commit = excluded.latest_commit, checked_at = excluded.checked_at, update_available = 0`,
              skillId, m.commit_sha ?? null, now(),
            );
          } else {
            // A rejected review changes the upstream baseline: clear any pending notice now.
            run('update upstream set update_available = 0 where skill_id = ?', skillId);
          }
          return { skillId, versionId };
        });
      } catch (e) {
        if (e?.errcode === SQLITE_CONSTRAINT_UNIQUE || e?.errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
          throw new ConflictError(`${m.slug} was published concurrently`);
        }
        throw e;
      }
    },

    async listUpdates({ grandfathered = false } = {}) {
      if (grandfathered) {
        return all(
          `select s.slug, s.name, v.reviewed_at
             from skills s join versions v on v.id = s.current_version_id
            where substr(v.review_notes, 1, 14) = 'grandfathered:' order by s.slug`, // LIKE would ignore ASCII case; Postgres' does not
        );
      }
      return all(
        `select s.slug, s.name, v.commit_sha as current_commit, ${BASELINE_COMMIT} as reviewed_commit,
                u.latest_commit, u.checked_at, src.url as source_url, s.source_path
           from skills s
           join upstream u on u.skill_id = s.id
           join versions v on v.id = s.current_version_id
           left join sources src on src.id = s.source_id
          where u.update_available and ${BASELINE_COMMIT} is not null
          order by s.slug`,
      );
    },

    // Same targets as lib/repo.mjs: github/git sources of skills with a current approved version, baselined on the
    // newest reviewed version that has a commit (null for a grandfathered import).
    async listUpstreamTargets() {
      return all(
        `select s.id as skill_id, src.kind, src.url, src.default_ref, ${BASELINE_COMMIT} as commit_sha, s.source_path, u.checked_at
           from skills s
           join sources src on src.id = s.source_id
           left join upstream u on u.skill_id = s.id
          where src.kind in ('github', 'git') and src.url is not null and s.current_version_id is not null`,
      );
    },

    async markUpstream(skillId, latestCommit, updateAvailable) {
      write(() => run(
        `insert into upstream (skill_id, latest_commit, checked_at, update_available) values (?, ?, ?, ?)
         on conflict (skill_id) do update
           set latest_commit = excluded.latest_commit, checked_at = excluded.checked_at, update_available = excluded.update_available`,
        skillId, latestCommit, now(), updateAvailable ? 1 : 0,
      ));
    },

    // Nothing about a user's searches or installs is stored locally.
    async logSearchEvent() {},
    async logInstallEvent() {},
  };
}
