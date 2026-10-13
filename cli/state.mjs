import { readFile, writeFile, rename, mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../lib/errors.mjs';

export async function loadState(dir) {
  const file = path.join(dir, 'state.json');
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, active: [] };
    throw e;
  }
  let state;
  try { state = JSON.parse(raw); } catch { throw new UserError(`${file} is corrupt; check it or delete it`); }
  if (state.version !== 1 || !Array.isArray(state.active)) throw new UserError(`${file} has an unknown format`);
  return state;
}

export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `state.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, path.join(dir, 'state.json'));
}

const LOCK_RETRIES = 50;
const LOCK_DELAY_MS = 100;
const LOCK_STALE_MS = 30e3;

// Serializes read-modify-write of state.json across processes (e.g. two agents running add at once): an exclusive
// lockfile created with 'wx', retried; a lock older than LOCK_STALE_MS was left by a crashed run and is taken over.
export async function withStateLock(dir, fn, { retries = LOCK_RETRIES, delayMs = LOCK_DELAY_MS, staleMs = LOCK_STALE_MS } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'state.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try { await handle.writeFile(`${process.pid}\n`); } finally { await handle.close(); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await stat(file).catch(() => null);
      if (st && Date.now() - st.mtimeMs > staleMs) { await unlink(file).catch(() => {}); continue; }
      if (attempt >= retries) throw new UserError(`${file} is held by another headjack; try again (if none is running, delete it)`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(file).catch(() => {});
  }
}

export function findEntry(state, slug) {
  return state.active.find((e) => e.slug === slug) ?? null;
}

const targetKey = (t) => t.path ?? `settings:${t.settings}`;

export function upsertEntry(state, entry) {
  const existing = findEntry(state, entry.slug);
  if (!existing) {
    state.active.push({ ...entry, targets: [...entry.targets] });
    return;
  }
  existing.kind = entry.kind;
  if (entry.sha256) existing.sha256 = entry.sha256;
  const byKey = new Map(existing.targets.map((t) => [targetKey(t), t]));
  for (const t of entry.targets) byKey.set(targetKey(t), t);
  existing.targets = [...byKey.values()];
}
