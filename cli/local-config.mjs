import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../lib/errors.mjs';

const LIST_KEYS = ['excludedRoots', 'corePlugins'];

// The CLI's state directory: HEADJACK_HOME when set and non-empty, else ~/.headjack. It must end up absolute: a
// relative one would make a state dir per working directory and every existing managed link look unmanaged.
export function stateDir({ env, home }) {
  const value = env.HEADJACK_HOME;
  if (!value) return path.resolve(home, '.headjack');
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new UserError(`HEADJACK_HOME must be an absolute path or start with ~/ (got "${value}")`);
  return path.resolve(expanded);
}

// <dir>/config.json; a missing file is {}. Unknown keys are ignored, so a newer config still loads.
export async function loadLocalConfig(dir) {
  const file = path.join(dir, 'config.json');
  const invalid = () => new UserError(`${file}: not a valid JSON object`);
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw invalid();
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw invalid();
  const config = {};
  for (const key of LIST_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    const v = data[key];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new UserError(`${file}: "${key}" must be an array of strings`);
    config[key] = v;
  }
  return config;
}

const lowerForm = (p) => path.resolve(p).toLowerCase();

// Each root carries every spelling a path under it may arrive with: through the home as given, through the resolved
// home, and through the root's own realpath (a symlinked root). Missing paths are compared through the first two.
export async function resolveExcludedRoots({ env, home, config }) {
  // An env value with no entries (empty, or only delimiters as in "$A:$B" with both unset) counts as unset.
  const fromEnv = (env.HEADJACK_EXCLUDED_ROOTS ?? '').split(path.delimiter).filter(Boolean);
  const entries = fromEnv.length ? fromEnv : (config.excludedRoots ?? []);
  const realHome = await realpath(home).catch(() => home);
  const roots = [];
  for (const written of entries) {
    const rel = written.startsWith('~/') ? written.slice(2) : null;
    if (rel === null && !path.isAbsolute(written)) throw new UserError(`excluded root "${written}" must be absolute or start with ~/`);
    const spellings = rel === null ? [written] : [path.join(home, rel), path.join(realHome, rel)];
    const real = await realpath(spellings[0]).catch(() => null);
    if (real) spellings.push(real);
    roots.push({ written, forms: [...new Set(spellings.map(lowerForm))] });
  }
  return roots;
}

// config.json, read at most once per command (cached on ctx). Only the commands that use a key call this.
export async function localConfigFor(ctx) {
  ctx.localConfig ??= await loadLocalConfig(ctx.dir);
  return ctx.localConfig;
}

// Only the commands that use excluded roots call this (review, import, add), so a malformed config.json never breaks
// search, list, verify or cleanup.
export async function excludedRootsFor(ctx) {
  ctx.excludedRoots ??= await resolveExcludedRoots({ env: ctx.env ?? process.env, home: ctx.home, config: await localConfigFor(ctx) });
  return ctx.excludedRoots;
}
