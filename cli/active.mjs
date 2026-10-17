// What is already loaded: shared by `search` (the `active` field) and the suggest pipeline, which must never offer a
// skill the session already has. Read-only; every unreadable source counts as nothing active.
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { loadState, findEntry } from './state.mjs';
import { HARNESSES, loadHarnesses, skillsDir } from './harness.mjs';

// Read-only view of ~/.claude/settings.json; an unreadable or malformed file counts as nothing enabled.
export async function enabledPlugins(home) {
  try {
    const on = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'))?.enabledPlugins;
    return on && typeof on === 'object' ? on : {};
  } catch { return {}; }
}

// Names of the skills in one directory: real directories and symlinks that resolve to one. Any error means none.
async function skillNames(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const names = [];
  for (const e of entries) {
    if (e.isDirectory()) names.push(e.name);
    else if (e.isSymbolicLink() && (await stat(path.join(dir, e.name)).catch(() => null))?.isDirectory()) names.push(e.name);
  }
  return names;
}

// A corrupt or unreadable harnesses.json must not stop `search` or a hook: fall back to the default harnesses.
async function detected(ctx) {
  try { return await loadHarnesses({ home: ctx.home, dir: ctx.dir }); } catch { return [...HARNESSES]; }
}

export async function activeKeys(ctx) {
  const state = await loadState(ctx.dir);
  const enabled = await enabledPlugins(ctx.home);
  const roots = (await detected(ctx)).map((h) => skillsDir(h, { home: ctx.home }));
  roots.push(path.join(ctx.cwd, '.claude', 'skills'));
  const dirs = [...new Set((await Promise.all([...new Set(roots)].map(skillNames))).flat())];
  return { state, enabled, dirs };
}

const pluginKey = (r) => r.plugin_slug ?? (r.kind === 'plugin' ? r.slug : null);
// An alternative is another install of the same plugin skill: "<plugin>@<marketplace>:<skill>".
const altPluginKey = (slug) => (slug.lastIndexOf(':') > 0 ? slug.slice(0, slug.lastIndexOf(':')) : null);

export function isActive(row, keys) {
  const plugins = [pluginKey(row), ...(row.alternatives ?? []).map(altPluginKey)].filter(Boolean);
  if ([row.slug, ...plugins].some((key) => findEntry(keys.state, key)) || plugins.some((key) => keys.enabled[key] === true)) return true;
  // A directory named like the slug marks only a standalone vault skill: plugin rows are matched by plugin key above.
  return !row.plugin_slug && row.kind !== 'plugin' && keys.dirs.includes(row.slug);
}

export function rawActiveKeys(keys) {
  const enabled = Object.keys(keys.enabled).filter((k) => keys.enabled[k] === true);
  return [...new Set([...keys.state.active.map((e) => e.slug), ...enabled, ...keys.dirs])].sort();
}
