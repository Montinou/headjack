// The repository methods the handlers and the local `updates` reach, over the SQLite vault (schema.mjs). Names,
// arguments and returned fields match lib/repo.mjs, normalized so the JSON the handlers send is identical: plain
// objects, true/false booleans, parsed tags/scan_flags/quality, ISO-8601 UTC timestamps. One implicit owner.
import { ConflictError } from '../errors.mjs';
import { tagsText } from '../tags.mjs';
import { collapseInstalls } from '../rank.mjs';
import { reviewOf } from '../review-status.mjs';
import { spanishTerms } from '../spanish.mjs';
import { ENRICHMENT_VERSION } from '../enrich-prompt.mjs';
import { FTS_TOKENIZE, FTS_TOKENIZE_ES } from './schema.mjs';

const MAX_TEXT_TERMS = 24;
const MIN_TERM_LENGTH = 2;
const SIGNAL_CANDIDATES = 50;
const MAX_MATCHED_TERMS = 12;
// Fusion tie order, and the tables searchSignals accepts. Each is ranked on its own: 'en' is skill_docs, 'es' is
// skill_docs_es (Spanish example requests, no stemming), and 'en-gloss' is skill_docs again with the glossary's English
// terms, restricted to skills whose Spanish was never enriched (enrichment_v is null).
const SIGNAL_TABLES = ['en', 'es', 'en-gloss'];
const SIGNAL_SOURCES = {
  en: { docs: 'skill_docs', bm25: 'bm25(skill_docs, 4, 3, 2, 1)', tokenize: FTS_TOKENIZE, where: '' },
  es: { docs: 'skill_docs_es', bm25: 'bm25(skill_docs_es)', tokenize: FTS_TOKENIZE_ES, where: '' },
  'en-gloss': { docs: 'skill_docs', bm25: 'bm25(skill_docs, 4, 3, 2, 1)', tokenize: FTS_TOKENIZE, where: 'and s.enrichment_v is null' },
};
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
    const source = SIGNAL_SOURCES[table];
    const rows = collapseInstalls(all(
      `select s.id, s.slug, s.name, s.plugin_slug, ${source.bm25} as score
         from ${source.docs} join skills s on s.id = ${source.docs}.rowid
        where ${source.docs} match ? and s.current_version_id is not null ${source.where}
        order by score, s.id limit ?`,
      terms.map((t) => `"${t}"`).join(' OR '), SIGNAL_CANDIDATES,
    ));
    return rows.map((r, i) => {
      const top = i === 0;
      return {
        id: r.id, slug: r.slug, name: r.name, plugin_slug: r.plugin_slug, alternatives: r.alternatives,
        fts_table: table, table_rank: i + 1, bm25: r.score,
        bm25_gap: top && rows.length > 1 ? rows[1].score - r.score : null,
        matched_terms: top ? matchedTerms(source, terms, r.id) : null,
      };
    });
  }

  // The number of distinct tokens among the first MAX_MATCHED_TERMS that match the table's row, one MATCH per token.
  // Terms are tokenized with the table's own tokenizer (skill_docs: porter stemming, case and diacritic folding; the
  // Spanish table: no stemming), so "tomato" and "Tomatoes" count once in English; each token is probed with the first
  // term that produced it.
  function matchedTerms(source, terms, rowid) {
    const probe = db.prepare(`select 1 as found from ${source.docs} where ${source.docs} match ? and rowid = ?`);
    // A BigInt binds as an INTEGER: a JS number binds as REAL, and an FTS5 table then ignores the rowid constraint, so
    // any other row matching the term would count.
    const id = BigInt(rowid);
    return distinctTokenTerms(source.tokenize, terms).filter((t) => probe.get(`"${t}"`, id)).length;
  }

  // A temp FTS5 table per tokenizer (allowed on a read-only connection) tokenizes the terms; fts5vocab lists the tokens
  // per row. Temp tables live on the connection, so each is named after its tokenizer: another repo on the same
  // connection then reuses the right one.
  const tokenizers = new Map();
  function distinctTokenTerms(tokenize, terms) {
    let tokenizer = tokenizers.get(tokenize);
    if (!tokenizer) {
      const n = tokenize.replace(/[^a-z0-9]+/g, '_');
      const termsTable = `temp.headjack_signal_terms_${n}`;
      const tokensTable = `temp.headjack_signal_tokens_${n}`;
      db.exec(`create virtual table if not exists ${termsTable} using fts5(term, tokenize='${tokenize}')`);
      db.exec(`create virtual table if not exists ${tokensTable} using fts5vocab(temp, headjack_signal_terms_${n}, instance)`);
      tokenizer = {
        clear: `delete from ${termsTable}`,
        insert: db.prepare(`insert into ${termsTable} (rowid, term) values (?, ?)`),
        tokens: db.prepare(`select doc, term from ${tokensTable} order by doc, offset`),
      };
      tokenizers.set(tokenize, tokenizer);
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
      db.exec(tokenizer.clear);
    }
  }

  // Inside a write: `versionId` becomes the skill's current version. The Spanish text described the previous version, so
  // it is cleared (with its FTS row) for --stale to re-enrich; skill_docs is rebuilt from the content chunks, and the
  // upstream baseline moves to the version's commit.
  function makeCurrent(skillId, versionId, { name, description, tags, commitSha, chunks }) {
    run(
      "update skills set current_version_id = ?, queries_es_text = '', enrichment_v = null where id = ?",
      versionId, skillId,
    );
    run('delete from skill_docs_es where rowid = ?', skillId);
    const body = chunks.filter((c) => (c.kind ?? 'content') === 'content').map((c) => c.text).join('\n');
    run('delete from skill_docs where rowid = ?', skillId);
    run(
      'insert into skill_docs (rowid, name, description, tags, body) values (?, ?, ?, ?, ?)',
      skillId, name, description, tagsText(tags), body,
    );
    run(
      `insert into upstream (skill_id, latest_commit, checked_at, update_available) values (?, ?, ?, 0)
       on conflict (skill_id) do update
         set latest_commit = excluded.latest_commit, checked_at = excluded.checked_at, update_available = 0`,
      skillId, commitSha, now(),
    );
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
    // wins (ties in SIGNAL_TABLES order, then bm25), and `limit` truncates only after all of that. Terms per table: 'en'
    // the query's words; 'es' the same minus Spanish filler; 'en-gloss' the caller's glossaryTerms (English), over
    // skills with no enrichment_v. Every term is cleaned and quoted like the query's own.
    async searchSignals(query, { limit = 5, tables = ['en'], glossaryTerms = [] } = {}) {
      for (const t of tables) if (!SIGNAL_TABLES.includes(t)) throw new Error(`unknown search table: ${t}`);
      const terms = searchTerms(query);
      const termsFor = {
        en: terms,
        es: spanishTerms(terms),
        'en-gloss': [...new Set(glossaryTerms.flatMap(searchTerms))].slice(0, MAX_TEXT_TERMS),
      };
      const perTable = SIGNAL_TABLES.filter((t) => tables.includes(t)).map((t) => signalsForTable(t, termsFor[t]));
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
      return get(
        `select s.slug, s.name, s.description, s.kind, s.plugin_slug, s.tags, s.quality, s.source_path,
                src.kind as source_kind, src.url as source_url, src.default_ref,
                v.commit_sha, v.sha256, v.size, v.reviewed_at, v.review_notes, v.scan_flags,
                coalesce(u.update_available, 0) as update_available, u.latest_commit,
                s.queries_es_text, s.enrichment_v
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
    // and not stored: a new approved version starts without Spanish text, which setSpanish (the local backfill) fills.
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
            makeCurrent(skillId, versionId, { name: m.name, description: m.description, tags, commitSha: m.commit_sha ?? null, chunks });
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

    // Writes queries_es_text, enrichment_v and the skill_docs_es row of one skill, in one transaction, and nothing else.
    // Returns false (writing nothing) when versionId is not the skill's current version; '' deletes the FTS row and
    // always stores a null enrichment_v, as the hosted repo does, so --stale picks the skill up again.
    async setSpanish(skillId, versionId, queriesEsText, enrichmentV) {
      const version = queriesEsText === '' ? null : enrichmentV;
      return write(() => {
        const changed = run(
          'update skills set queries_es_text = ?, enrichment_v = ? where id = ? and current_version_id = ?',
          queriesEsText, version, skillId, versionId,
        ).changes;
        if (!changed) return false;
        run('delete from skill_docs_es where rowid = ?', skillId);
        if (queriesEsText !== '') run('insert into skill_docs_es (rowid, queries) values (?, ?)', skillId, queriesEsText);
        return true;
      });
    },

    // The skills local enrichment works on, each with the text of its current version: { id, version_id, slug, name,
    // description, body, enrichment_v }, in publish order. `slugs` (a non-empty list) selects those skills only;
    // without it the default is every skill with no Spanish text yet. `stale` keeps skills whose enrichment_v is null or
    // older than ENRICHMENT_VERSION. Skills without a current version never appear.
    async listEnrichTargets({ slugs = null, stale = false } = {}) {
      const named = Array.isArray(slugs) && slugs.length > 0;
      const where = ['s.current_version_id is not null'];
      const params = [];
      if (named) {
        where.push(`s.slug in (${slugs.map(() => '?').join(', ')})`);
        params.push(...slugs);
      } else if (!stale) {
        where.push("s.queries_es_text = ''");
      }
      if (stale) {
        where.push('(s.enrichment_v is null or s.enrichment_v < ?)');
        params.push(ENRICHMENT_VERSION);
      }
      return all(
        `select s.id, s.current_version_id as version_id, s.slug, s.name, s.description,
                coalesce(d.body, '') as body, s.enrichment_v
           from skills s left join skill_docs d on d.rowid = s.id
          where ${where.join(' and ')} order by s.id`,
        ...params,
      );
    },

    // Makes the existing approved version of `slug` with `sha256` current again (headjack pull: --replace, or a hosted
    // rollback to content the vault already holds), in one transaction, as publish does for a new approved version:
    // name, description and tags are updated, the Spanish text is cleared and skill_docs is rebuilt from `chunks`
    // ({ text, kind }). Returns { skillId, versionId }, or null (writing nothing) when no approved version of that slug has
    // that sha256.
    async setCurrentVersion({ slug, sha256, name, description, tags = [], chunks }) {
      return write(() => {
        const row = get(
          `select s.id as skill_id, v.id as version_id, v.commit_sha from versions v join skills s on s.id = v.skill_id
            where s.slug = ? and v.sha256 = ? and v.status = 'approved'`,
          slug, sha256,
        );
        if (!row) return null;
        run('update skills set name = ?, description = ?, tags = ? where id = ?', name, description, JSON.stringify(tags), row.skill_id);
        makeCurrent(row.skill_id, row.version_id, { name, description, tags, commitSha: row.commit_sha ?? null, chunks });
        return { skillId: row.skill_id, versionId: row.version_id };
      });
    },

    // The pull record of one slug (`headjack pull`, spec §9): { slug, sha256, pulled_at }, or null when it was never pulled.
    async getPull(slug) {
      return get('select slug, sha256, pulled_at from pulls where slug = ?', slug);
    },

    // Records that a pull stored `sha256` for `slug`, replacing any earlier record of that slug.
    async recordPull(slug, sha256) {
      write(() => run(
        `insert into pulls (slug, sha256, pulled_at) values (?, ?, ?)
         on conflict (slug) do update set sha256 = excluded.sha256, pulled_at = excluded.pulled_at`,
        slug, sha256, now(),
      ));
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
