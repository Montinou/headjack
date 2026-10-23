// sqlite-vec is a loadable, not an npm package. A missing or unloadable file is a soft miss: search stays full text.
// "extension loading is not allowed" is a caller that opened without allowExtension, and it must not look like that miss.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_DENIED = 'extension loading is not allowed';

const CHUNK_VECS = `create virtual table chunk_vecs using vec0(
  embedding float[1536] distance_metric=cosine,
  skill_id integer,
  version_id integer
)`;

function defaultVecPath() {
  const fromEnv = process.env.HEADJACK_VEC_PATH;
  if (fromEnv) return fromEnv;
  const cliDir = path.dirname(fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url)));
  const ext = process.platform === 'darwin' ? 'dylib' : 'so';
  return path.join(cliDir, 'vendor', `vec0.${process.platform}-${process.arch}.${ext}`);
}

export function loadVec(db, loadablePath = defaultVecPath()) {
  if (!loadablePath || !existsSync(loadablePath)) return false;
  try {
    db.loadExtension(loadablePath);
    const present = db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n;
    if (!present) db.exec(CHUNK_VECS);
    return true;
  } catch (error) {
    if (String(error?.message ?? '').includes(EXTENSION_DENIED)) throw error;
    return false;
  }
}
