// The local search adapter of the suggestion pipeline (spec §3.3): the search itself is read-only and never touches the
// network. Only the optional `migrate` step writes (it opens the vault with openVault, which waits up to 5 s on a lock);
// callers pass it for entry 'manual' and for warmup, never on the prompt path. Every search queries the English and the
// Spanish example-request tables; a query guessLang calls Spanish also queries the glossary's English terms (spec §8.2).
// No npm dependencies; SQLite is loaded through runtimeCheck only when a vault exists.
import { existsSync } from 'node:fs';
import { glossaryTerms } from './es-glossary.mjs';
import { UserError } from './errors.mjs';
import { guessLang } from './lang-guess.mjs';
import { damagedMessage, isBusy, isDamaged, openVault, openVaultReadOnly, vaultFile } from './local/schema.mjs';
import { runtimeCheck } from './local/runtime.mjs';
import { createSqliteRepo, searchTerms } from './local/sqlite-repo.mjs';

const LIMIT = 5;
const BUSY_TIMEOUT_MS = 200;

// localSearch({ dir, query, migrate }) resolves to { candidates, variant: 'local' }, or to { outcome } when the search
// is skipped: 'skipped:no-vault' (no vault.db: nothing is created, whatever `migrate` says), 'skipped:schema' (the vault
// is not at this headjack's schema and `migrate` is false, or it cannot be migrated) or 'skipped:busy' (another process
// holds a lock past the busy timeout). None of them is a transport failure. With `migrate` and an existing vault, the
// vault is opened once with openVault first (applying pending migrations), then read-only. `DatabaseSync` may be
// injected; otherwise it comes from runtimeCheck, which throws a UserError on a Node without SQLite FTS5.
export async function localSearch({ dir, query, migrate = false, DatabaseSync }) {
  if (!existsSync(vaultFile(dir))) return { outcome: 'skipped:no-vault' };
  const sqlite = DatabaseSync ?? (await runtimeCheck()).DatabaseSync;
  if (migrate) {
    try {
      openVault({ dir, DatabaseSync: sqlite }).close();
    } catch (e) {
      if (isBusy(e)) return { outcome: 'skipped:busy' };
      // Anything else (a newer or damaged vault) is reported by the read-only open below as a schema skip.
    }
  }
  const opened = openVaultReadOnly({ dir, DatabaseSync: sqlite, busyTimeoutMs: BUSY_TIMEOUT_MS });
  if (!opened.ok) return { outcome: `skipped:${opened.reason}` };
  try {
    const spanish = guessLang(query) === 'es';
    const candidates = await createSqliteRepo(opened.db).searchSignals(query, {
      limit: LIMIT,
      tables: spanish ? ['en', 'es', 'en-gloss'] : ['en', 'es'],
      ...(spanish ? { glossaryTerms: glossaryTerms(searchTerms(query)) } : {}),
    });
    return { candidates, variant: 'local' };
  } catch (e) {
    if (isBusy(e)) return { outcome: 'skipped:busy' };
    // Pages that stopped being a database are found only by a query: report them like every other command does.
    if (isDamaged(e)) throw new UserError(damagedMessage(dir), { cause: e });
    throw e;
  } finally {
    opened.db.close();
  }
}
