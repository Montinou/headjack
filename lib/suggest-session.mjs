import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Per-session store of the suggestion pipeline: <dir>/suggest/sessions/<session>.json holds the slugs already suggested in
// that session (dedupe, spec §3.4 item 5) and, for the prompt hook, the circuit breaker state (spec §3.8): consecutive
// `failures`, `openUntil` (epoch ms or null) and `configLogged` (the malformed-config line was written). Files untouched
// for 24 hours are pruned. Slugs and counters only, never prompt text. Best effort by contract: the callers catch whatever
// these throw. No npm dependencies.

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

async function readDoc(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

const slugsOf = (doc) => (Array.isArray(doc.slugs) ? doc.slugs.filter((s) => typeof s === 'string') : []);

// The breaker part of a document, with defaults for what is absent or of the wrong type.
function breakerOf(doc) {
  return {
    failures: Number.isInteger(doc.failures) && doc.failures > 0 ? doc.failures : 0,
    openUntil: Number.isFinite(doc.openUntil) ? doc.openUntil : null,
    configLogged: doc.configLogged === true,
  };
}

async function writeDoc(dir, file, doc) {
  await mkdir(sessionsDir(dir), { recursive: true, mode: DIR_MODE });
  await chmod(sessionsDir(dir), DIR_MODE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(doc)}\n`, { mode: FILE_MODE });
    await chmod(tmp, FILE_MODE);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// Deletes the session files untouched for more than 24 hours. Best effort: never throws.
export async function pruneSessions(dir, now = Date.now()) {
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

// { seen(id) → Set of slugs, add(id, slugs), breaker(id) → { failures, openUntil, configLogged }, setBreaker(id, patch) }
// over <dir>/suggest/sessions. Every write keeps the fields it does not own.
export function sessionStore(dir, { now = Date.now } = {}) {
  return {
    async seen(id) {
      return new Set(slugsOf(await readDoc(sessionFile(dir, id))));
    },
    async add(id, slugs) {
      const file = sessionFile(dir, id);
      const doc = await readDoc(file);
      await writeDoc(dir, file, { ...doc, slugs: [...new Set([...slugsOf(doc), ...slugs])] });
      await pruneSessions(dir, now());
    },
    async breaker(id) {
      return breakerOf(await readDoc(sessionFile(dir, id)));
    },
    async setBreaker(id, patch) {
      const file = sessionFile(dir, id);
      const doc = await readDoc(file);
      await writeDoc(dir, file, { ...doc, ...breakerOf({ ...doc, ...patch }), slugs: slugsOf(doc) });
    },
  };
}
