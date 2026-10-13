// Local mode's entry check: a feature probe, not a version comparison. Bundled SQLite has FTS5 only from Node 22.16 and
// 24.0; hosted mode never calls this, so it never loads node:sqlite.
import { UserError } from '../errors.mjs';

const isSqliteExperimental = (warning, typeOrOptions) => {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
  const name = type ?? warning?.name;
  const message = typeof warning === 'string' ? warning : warning?.message;
  return name === 'ExperimentalWarning' && typeof message === 'string' && message.startsWith('SQLite');
};

// `cause` is the underlying failure, so HEADJACK_DEBUG (or a test) can show why the probe failed.
const unsupported = (cause) =>
  new UserError(`local mode needs a Node with SQLite FTS5 (Node 22.16 or newer, or 24+; found ${process.version})`, { cause });

/** @returns {Promise<{ DatabaseSync: any }>} */
export async function runtimeCheck({ load = () => import('node:sqlite') } = {}) {
  // Node 22.x prints an ExperimentalWarning about SQLite on every start; drop only that one, only during the load.
  const original = process.emitWarning;
  let mod;
  try {
    process.emitWarning = /** @type {any} */ (function (warning, ...rest) {
      if (isSqliteExperimental(warning, rest[0])) return;
      return Reflect.apply(original, process, [warning, ...rest]);
    });
    mod = await load();
  } catch (e) {
    throw unsupported(e);
  } finally {
    process.emitWarning = original;
  }
  try {
    const db = new mod.DatabaseSync(':memory:');
    try {
      db.exec("create virtual table probe using fts5(a, tokenize='porter unicode61 remove_diacritics 2')");
    } finally {
      db.close();
    }
  } catch (e) {
    throw unsupported(e);
  }
  return { DatabaseSync: mod.DatabaseSync };
}
