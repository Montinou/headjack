import path from 'node:path';
import { readFile, writeFile, mkdir, rename, stat, realpath, lstat } from 'node:fs/promises';
import { UserError } from '../lib/errors.mjs';
import { stateDir } from './local-config.mjs';
import { HARNESSES, KNOWN_HARNESSES } from '../lib/harness-catalog.mjs';

export { HARNESSES, KNOWN_HARNESSES };

const known = () => Object.keys(KNOWN_HARNESSES);
const unknown = (h) => new UserError(`unknown harness: ${h} (valid: ${known().join(', ')}, all)`);
const registryFile = (home, dir) => path.join(dir ?? stateDir({ env: process.env, home }), 'harnesses.json');

// `all` expands to the detected list (the trio when `harness detect` never ran).
export function parseHarnessList(value, detected = HARNESSES) {
  if (!value) return [...HARNESSES];
  const out = [];
  for (const h of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (h === 'all') out.push(...detected);
    else if (Object.hasOwn(KNOWN_HARNESSES, h)) out.push(h);
    else throw unknown(h);
  }
  return [...new Set(out)];
}

// Reads harnesses.json only when the list says `all`, so a corrupt registry breaks only the commands that need it.
export async function resolveHarnessList(value, ctx) {
  const wantsAll = typeof value === 'string' && value.split(',').some((s) => s.trim() === 'all');
  return parseHarnessList(value, wantsAll ? await loadHarnesses(ctx) : HARNESSES);
}

// A filter flag that was given must name at least one harness: "" or "," would otherwise read as "no filter".
export function requireHarnessFilter(value, flag) {
  if (typeof value !== 'string' || !value.split(',').some((s) => s.trim())) throw new UserError(`${flag} needs at least one harness (valid: ${known().join(', ')}, all)`);
  return value;
}

export function skillsDir(harness, { home, cwd, project }) {
  if (!Object.hasOwn(KNOWN_HARNESSES, harness)) throw unknown(harness);
  const { global, project: rel } = KNOWN_HARNESSES[harness];
  if (!project) return path.join(home, global);
  if (!rel) throw new UserError(`${harness} has no per-project skills directory; use it without --project`);
  return path.join(cwd, rel);
}

// Where a harness's global skills dir really is: its realpath or, while it does not exist yet, its nearest existing
// ancestor's realpath plus the rest. `symlinked`: reached through a link, or unresolvable (a dangling link, real null).
export async function resolveHarnessDir(harness, home) {
  const dir = skillsDir(harness, { home });
  const expected = path.join(await realpath(home).catch(() => home), KNOWN_HARNESSES[harness].global);
  const rest = [];
  for (let cur = dir; ;) {
    try {
      const real = path.join(await realpath(cur), ...rest);
      return { dir, real, symlinked: real !== expected };
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    const parent = path.dirname(cur);
    if (parent === cur || (await lstat(cur).then(() => true, () => false))) return { dir, real: null, symlinked: true };
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

export function claudeSettingsPath({ home, cwd, project }) {
  return path.join(project ? cwd : home, '.claude', 'settings.json');
}

// Ids whose global skills dir exists (following symlinks), in table order; saved to <state dir>/harnesses.json.
export async function detectHarnesses({ home, dir }) {
  const found = [];
  for (const h of known()) {
    const st = await stat(skillsDir(h, { home })).catch(() => null);
    if (st?.isDirectory()) found.push(h);
  }
  const file = registryFile(home, dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, detected_at: new Date().toISOString(), harnesses: found }, null, 2) + '\n');
  await rename(tmp, file);
  return found;
}

export async function loadHarnesses({ home, dir }) {
  const file = registryFile(home, dir);
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [...HARNESSES];
    throw e;
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new UserError(`${file} is corrupt; run: headjack harness detect`); }
  if (!Array.isArray(data?.harnesses)) throw new UserError(`${file} has an unknown format; run: headjack harness detect`);
  return data.harnesses.filter((h) => Object.hasOwn(KNOWN_HARNESSES, h));
}
