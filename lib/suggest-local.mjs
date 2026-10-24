// Local suggestion search preserves full-text decision signals. The hook uses a read-only, offline connection;
// manual/eval hybrid reads use a writable extension-enabled connection and append vector neighbors for explanation.
// No npm dependencies; SQLite is loaded through runtimeCheck only when a vault exists.
import { aiGatewayKey, embedTexts } from '../cli/embed-local.mjs';
import { searchHybrid } from './local/hybrid.mjs';
import { existsSync } from 'node:fs';
import { glossaryTerms } from './es-glossary.mjs';
import { UserError } from './errors.mjs';
import { guessLang } from './lang-guess.mjs';
import { damagedMessage, isBusy, isDamaged, openVault, openVaultReadOnly, vaultFile } from './local/schema.mjs';
import { runtimeCheck } from './local/runtime.mjs';
import { createSqliteRepo, searchTerms } from './local/sqlite-repo.mjs';

const LIMIT = 5;
const BUSY_TIMEOUT_MS = 200;

// localSearch({ dir, query, migrate, hybrid }) resolves to { candidates, variant: 'local' }, or to { outcome } when the search
// is skipped: 'skipped:no-vault' (no vault.db: nothing is created, whatever `migrate` says), 'skipped:schema' (the vault
// is not at this headjack's schema and `migrate` is false, or it cannot be migrated) or 'skipped:busy' (another process
// holds a lock past the busy timeout). None of them is a transport failure. A vault that is not a database at all (damage)
// throws a UserError with the damaged-vault message, whether found on open or during the search. With `migrate` and an
// existing vault, migrations run before a non-hybrid read-only open. Hybrid reads open writable for stale-vector cleanup. `DatabaseSync` may be
// injected; otherwise it comes from runtimeCheck, which throws a UserError on a Node without SQLite FTS5.
export async function localSearch({ dir, query, migrate = false, hybrid = false, DatabaseSync, env = process.env, fetchImpl = fetch }) {
  if (!existsSync(vaultFile(dir))) return { outcome: 'skipped:no-vault' };
  const sqlite = DatabaseSync ?? (await runtimeCheck()).DatabaseSync;
  if (migrate) {
    try {
      openVault({ dir, DatabaseSync: sqlite }).close();
    } catch (e) {
      if (isBusy(e)) return { outcome: 'skipped:busy' };
      // Anything else (a newer or damaged vault) is reported by the read-only open below: a schema skip, or the damage.
    }
  }
  let opened;
  try {
    opened = hybrid
      ? { ok: true, db: openVault({ dir, DatabaseSync: sqlite, allowExtension: true }) }
      : openVaultReadOnly({ dir, DatabaseSync: sqlite, busyTimeoutMs: BUSY_TIMEOUT_MS });
  } catch (e) {
    if (isBusy(e)) return { outcome: 'skipped:busy' };
    if (isDamaged(e) || e.code === 'vault_damaged') throw new UserError(damagedMessage(dir), { cause: e });
    // A writable open rejects a newer schema; retain the read-only suggestion classification.
    const probe = openVaultReadOnly({ dir, DatabaseSync: sqlite, busyTimeoutMs: BUSY_TIMEOUT_MS });
    if (probe.ok) probe.db.close();
    else if (probe.reason === 'damaged') throw new UserError(damagedMessage(dir), { cause: e });
    else return { outcome: `skipped:${probe.reason}` };
    throw e;
  }
  // Pages that are not a database: the manual command reports it like every other command; the hook ends in no output.
  if (!opened.ok && opened.reason === 'damaged') throw new UserError(damagedMessage(dir));
  if (!opened.ok) return { outcome: `skipped:${opened.reason}` };
  try {
    const spanish = guessLang(query) === 'es';
    const repo = createSqliteRepo(opened.db);
    const readSignals = () => repo.searchSignals(query, {
      limit: LIMIT,
      // An English prompt searches only the English text: the Spanish example requests share loanwords and product names
      // with it ("podcast", "neon"), and on 159 labelled prompts those matches were mostly wrong suggestions.
      tables: spanish ? ['en', 'es', 'en-gloss'] : ['en'],
      // A Spanish prompt is best answered by the Spanish example requests: on equal rank they come first.
      ...(spanish ? { tableOrder: ['es', 'en', 'en-gloss'] } : {}),
      ...(spanish ? { glossaryTerms: glossaryTerms(searchTerms(query)) } : {}),
    });
    let candidates;
    if (hybrid) {
      let key = null;
      try { key = await aiGatewayKey({ env, dir }); }
      catch (e) { if (!(e instanceof UserError)) throw e; }
      // No database snapshot spans key lookup or embedding. Decision signals and fused metadata must
      // describe the same current versions; a unique slug alone cannot guarantee that after an await.
      const readSnapshot = async read => {
        opened.db.exec('BEGIN IMMEDIATE');
        try {
          candidates = await readSignals();
          const rows = await read();
          opened.db.exec('COMMIT');
          return rows;
        } catch (error) {
          if (opened.db.isTransaction) opened.db.exec('ROLLBACK');
          throw error;
        }
      };
      const fused = key ? await searchHybrid({
        db: opened.db, repo, query, limit: LIMIT, tags: [], readSnapshot,
        embed: texts => embedTexts({ texts, key, fetchImpl }),
      }) : await readSnapshot(() => []);
      // Slugs are unique and both lists now come from the same current-version snapshot.
      const bySlug = new Map(fused.map(row => [row.slug, row]));
      for (const row of candidates) {
        const match = bySlug.get(row.slug);
        Object.assign(row, { vector_rank: match?.vector_rank ?? null, similarity: match?.similarity ?? null, matched: match?.matched ?? 'fts' });
        bySlug.delete(row.slug);
      }
      for (const row of bySlug.values()) candidates.push({ ...row, table_rank: null });
    } else candidates = await readSignals();
    return { candidates, variant: 'local' };
  } catch (e) {
    if (isBusy(e)) return { outcome: 'skipped:busy' };
    // Pages that stopped being a database are found only by a query: report them like every other command does.
    if (isDamaged(e) || e.code === 'vault_damaged') throw new UserError(damagedMessage(dir), { cause: e });
    throw e;
  } finally {
    opened.db.close();
  }
}
