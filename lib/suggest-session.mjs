import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Per-session dedupe store of the suggestion pipeline (spec §3.4 item 5): <dir>/suggest/sessions/<session>.json holds the
// slugs already suggested in that session; files untouched for 24 hours are pruned. Slugs only, never prompt text.
// Best effort by contract: the pipeline catches whatever these throw. No npm dependencies.

export const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const sessionsDir = (dir) => path.join(dir, 'suggest', 'sessions');

// The path is built from the id, so an id that does not match SESSION_ID_RE never reaches the file system.
function sessionFile(dir, id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new TypeError('invalid session id');
  return path.join(sessionsDir(dir), `${id}.json`);
}

async function readSlugs(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(data?.slugs) ? data.slugs.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

async function prune(dir, now) {
  let names;
  try { names = await readdir(sessionsDir(dir)); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(sessionsDir(dir), name);
    try {
      if (now - (await stat(file)).mtimeMs > MAX_AGE_MS) await unlink(file);
    } catch { /* best effort */ }
  }
}

// { seen(id) → Set of slugs, add(id, slugs) } over <dir>/suggest/sessions.
export function sessionStore(dir, { now = Date.now } = {}) {
  return {
    async seen(id) {
      return new Set(await readSlugs(sessionFile(dir, id)));
    },
    async add(id, slugs) {
      const file = sessionFile(dir, id);
      const merged = [...new Set([...await readSlugs(file), ...slugs])];
      await mkdir(sessionsDir(dir), { recursive: true, mode: DIR_MODE });
      await chmod(sessionsDir(dir), DIR_MODE);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify({ slugs: merged })}\n`, { mode: FILE_MODE });
        await chmod(tmp, FILE_MODE);
        await rename(tmp, file);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await prune(dir, now());
    },
  };
}
