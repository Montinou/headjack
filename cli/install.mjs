import { lstat, readlink, realpath, mkdir, mkdtemp, rename, rm, symlink, unlink, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { hashFiles, hashDir } from '../lib/hash.mjs';
import { unpack, writeFiles } from '../lib/tar.mjs';
import { UserError } from '../lib/errors.mjs';
import { loadState, saveState, findEntry, upsertEntry, withStateLock } from './state.mjs';
import { skillsDir, claudeSettingsPath, requireHarnessFilter, resolveHarnessDir, resolveHarnessList } from './harness.mjs';
import { excludedRootOf } from './scan.mjs';
import { excludedRootsFor } from './local-config.mjs';
import { setPluginsEnabled, readEnabledPlugins } from './settings.mjs';
import { appendEvent } from '../lib/suggest-log.mjs';
import { SESSION_ID_RE } from '../lib/suggest-session.mjs';

export const storeDir = (dir) => path.join(dir, 'store');
const exists = (p) => access(p).then(() => true, () => false);

// realpath of p; while p (or its tail) does not exist, its nearest existing ancestor's realpath plus the rest.
// A dangling link therefore still compares by the real location of the part that exists, lexically beyond it.
async function realpathLoose(p) {
  const rest = [];
  for (let cur = p; ;) {
    try { return path.join(await realpath(cur), ...rest); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; // anything else (EACCES, ELOOP...) is not "missing"
    }
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

const isUnder = (root, p) => p.startsWith(root + path.sep);

// `target` is the link's lexical target; `real` its resolved location. The state dir may be reached through a
// symlink (~/.headjack -> a legacy state directory), so ownership is judged on real paths, never on the spelling.
export async function linkStatus(p, store) {
  let st;
  try { st = await lstat(p); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, managed: false };
    throw e;
  }
  if (!st.isSymbolicLink()) return { exists: true, managed: false };
  const target = path.resolve(path.dirname(p), await readlink(p));
  let real;
  try { real = await realpathLoose(target); } catch (e) {
    // A link that cannot be resolved (a loop, an unreadable directory) was never ours: treat it as unmanaged.
    if (e.code === 'ELOOP' || e.code === 'EACCES') return { exists: true, managed: false };
    throw e;
  }
  return { exists: true, managed: isUnder(await realpathLoose(store), real), target, real };
}

async function materialize(slug, skill, ctx) {
  const store = storeDir(ctx.dir);
  const finalDir = path.join(store, skill.sha256, slug);
  if (await exists(finalDir)) return finalDir;
  const { sha256, tarball } = await ctx.api.download(slug);
  const files = unpack(tarball);
  const actual = hashFiles(files);
  if (actual !== skill.sha256 || sha256 !== skill.sha256) {
    throw new UserError(`hash mismatch for ${slug}: expected ${skill.sha256}, got ${actual}; installing nothing`);
  }
  await mkdir(store, { recursive: true });
  const tmp = await mkdtemp(path.join(store, '.tmp-'));
  try {
    await writeFiles(path.join(tmp, slug), files);
    await mkdir(path.dirname(finalDir), { recursive: true });
    await rename(path.join(tmp, slug), finalDir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
    const shaDir = path.dirname(finalDir);
    if (!(await exists(finalDir)) && (await exists(shaDir)) && !(await readdir(shaDir)).length) await rm(shaDir, { recursive: true });
  }
  return finalDir;
}

// Session installs are removed by `cleanup`. A non-session add makes the entry permanent; a session add never
// downgrades an entry that was already permanent.
function markSession(state, slug, session, wasPermanent) {
  const e = findEntry(state, slug);
  if (session && !wasPermanent) {
    e.session = true;
    e.addedAt = new Date().toISOString();
  } else {
    delete e.session;
    delete e.addedAt;
  }
}

export async function add(slug, opts, ctx) {
  const skill = await ctx.api.getSkill(slug);
  if (!skill) throw new UserError(`"${slug}" is not in the vault; try: headjack search "<what you need>"`);
  const managed = await withStateLock(ctx.dir, () => addLocked(slug, skill, opts, ctx));
  const kind = skill.kind;
  // Outside the lock; the event is telemetry, so a failure never fails the add.
  if (managed) {
    try { await ctx.api.installEvent({ slug, kind, source: opts.source ?? 'manual' }); } catch { /* ignored */ }
  }
  // The add event feeds the outcome report (spec §5.1). Best effort: appendEvent never throws, and nothing here can change
  // the exit code. It carries a slug and a source label, never prompt text.
  const sessionId = ctx.env?.CLAUDE_CODE_SESSION_ID;
  const session = typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : null;
  await appendEvent(ctx.dir, { type: 'add', session, at: new Date().toISOString(), slug, source: opts.source ?? 'manual' });
  return { managed, kind };
}

// Resolves true when headjack manages the install, false when it left a user-enabled plugin alone.
async function addLocked(slug, skill, opts, ctx) {
  const state = await loadState(ctx.dir);

  if (skill.kind === 'plugin' || skill.plugin_slug) {
    const plugin = skill.plugin_slug ?? skill.slug;
    const settings = claudeSettingsPath({ home: ctx.home, cwd: ctx.cwd, project: opts.project });
    // Enabled by the user before (e.g. a core plugin): taking ownership would let `remove` disable it.
    const owned = findEntry(state, plugin)?.targets.some((t) => t.settings === settings);
    if (!owned && (await readEnabledPlugins(settings))[plugin] === true) {
      ctx.log(`plugin ${plugin} was already enabled; headjack does not manage it`);
      return false;
    }
    const prior = findEntry(state, plugin);
    await setPluginsEnabled(settings, { [plugin]: true });
    upsertEntry(state, { slug: plugin, kind: 'plugin', targets: [{ harness: 'claude', settings }] });
    markSession(state, plugin, opts.session, Boolean(prior && !prior.session));
    await saveState(ctx.dir, state);
    ctx.log(`plugin ${plugin} enabled in ${settings}. Restart the Claude Code session to load it.`);
    return true;
  }

  if (!skill.sha256) throw new UserError(`"${slug}" has no approved version`);
  const store = storeDir(ctx.dir);
  const harnesses = await resolveHarnessList(opts.to, ctx);
  if (!opts.project) {
    // A symlinked harness dir is written through only when named in --to (not via the default or `all`), and one
    // that resolves under an excluded root never.
    const named = new Set((opts.to ?? '').split(',').map((s) => s.trim()));
    for (const h of harnesses) {
      const { dir, real, symlinked } = await resolveHarnessDir(h, ctx.home);
      if (!symlinked) continue;
      if (real === null) throw new UserError(`${dir} is a broken symlink; not installing there`);
      const root = excludedRootOf(real, await excludedRootsFor(ctx));
      if (root !== null) throw new UserError(`${dir} resolves under an excluded root (${root}); not installing there`);
      if (!named.has(h)) throw new UserError(`${dir} is a symlink to ${real}; to install there anyway, name it: --to ${h}`);
    }
  }
  const requested = harnesses.map((h) => ({ harness: h, path: path.join(skillsDir(h, { home: ctx.home, cwd: ctx.cwd, project: opts.project }), slug) }));
  const previous = findEntry(state, slug)?.targets.filter((t) => t.path) ?? [];
  const dests = [...new Map([...previous, ...requested].map((t) => [t.path, t])).values()];

  for (const d of dests) {
    const s = await linkStatus(d.path, store);
    if (s.exists && !s.managed) throw new UserError(`${d.path} already exists and headjack does not manage it; not overwriting it`);
  }

  const finalDir = await materialize(slug, skill, ctx);
  for (const d of dests) {
    await mkdir(path.dirname(d.path), { recursive: true });
    await rm(d.path, { force: true });
    await symlink(finalDir, d.path, 'dir');
  }
  const prior = findEntry(state, slug);
  upsertEntry(state, { slug, kind: 'skill', sha256: skill.sha256, targets: dests });
  markSession(state, slug, opts.session, Boolean(prior && !prior.session));
  await saveState(ctx.dir, state);
  ctx.log(`${slug} active in: ${[...new Set(dests.map((d) => d.harness))].join(', ')}. If the session was already open, restart it to load the skill.`);
  return true;
}

// The entry for `slug` as given; else, for a plugin skill `<plugin>@<marketplace>:<skill>`, its plugin's entry.
export function resolveEntry(state, slug) {
  const exact = findEntry(state, slug);
  if (exact) return exact;
  const m = /^(.+@[^:]+):.+$/.exec(slug);
  return m ? findEntry(state, m[1]) : null;
}

// With ifSession, removes only a session entry (resolved through resolveEntry); anything else is a logged no-op.
export function remove(slug, opts, ctx) {
  return withStateLock(ctx.dir, async () => {
    if (!opts.ifSession) return removeLocked(slug, opts, ctx);
    const entry = resolveEntry(await loadState(ctx.dir), slug);
    if (!entry) return ctx.log(`${slug}: not active, nothing to remove`);
    if (entry.session !== true) return ctx.log(`${slug}: permanent install, not removing it`);
    return removeLocked(entry.slug, opts, ctx);
  });
}

async function removeLocked(slug, opts, ctx) {
  const state = await loadState(ctx.dir);
  const entry = findEntry(state, slug);
  if (!entry) throw new UserError(`"${slug}" is not active (see headjack list; plugins are removed by their key <name>@<marketplace>)`);

  if (entry.kind === 'plugin') {
    for (const t of entry.targets) await setPluginsEnabled(t.settings, { [slug]: false });
    state.active = state.active.filter((e) => e !== entry);
    await saveState(ctx.dir, state);
    ctx.log(`plugin ${slug} disabled. Restart the Claude Code session.`);
    return;
  }

  const only = opts.from ? await resolveHarnessList(opts.from, ctx) : null;
  const store = storeDir(ctx.dir);
  const keep = [];
  for (const t of entry.targets) {
    if (only && !only.includes(t.harness)) { keep.push(t); continue; }
    const s = await linkStatus(t.path, store);
    if (s.exists && !s.managed) { ctx.log(`warning: ${t.path} is no longer an headjack symlink; keeping it`); continue; }
    if (s.exists) await unlink(t.path);
  }
  entry.targets = keep;
  if (!keep.length) state.active = state.active.filter((e) => e !== entry);
  await saveState(ctx.dir, state);
  ctx.log(`${slug} removed${only ? ` from ${only.join(', ')}` : ''}.`);
}

const UNITS = { m: 60e3, h: 3600e3, d: 86400e3 };

export function parseDuration(value, flag = '--older-than') {
  const m = /^(\d+)([mhd])$/.exec(value ?? '');
  if (!m) throw new UserError(`${flag} expects a duration such as 30m, 12h or 2d (got "${value}")`);
  return Number(m[1]) * UNITS[m[2]];
}

// Removes session entries through `remove`, so only managed links go and plugins end up false in settings.
// Returns what it removed (or would remove, with dryRun) as [{ slug, kind, harnesses, error? }].
export async function cleanup(opts, ctx) {
  // A flag that was given (even as "") filters; only an absent flag means "no filter".
  const cutoff = opts.olderThan != null ? Date.now() - parseDuration(opts.olderThan) : null;
  const only = opts.harness != null ? await resolveHarnessList(requireHarnessFilter(opts.harness, '--harness'), ctx) : null;
  // Planning and removing happen under one lock, so a parallel add/remove cannot slip in between.
  const run = async () => {
    const state = await loadState(ctx.dir);
    const plan = [];
    for (const e of state.active) {
      if (e.session !== true) continue;
      if (cutoff !== null && !(Date.parse(e.addedAt) <= cutoff)) continue;
      const harnesses = [...new Set(e.targets.map((t) => t.harness))].filter((h) => !only || only.includes(h));
      if (only && !harnesses.length) continue;
      plan.push({ slug: e.slug, kind: e.kind, harnesses });
    }
    if (opts.dryRun) return plan;
    // One failing entry (e.g. a corrupt settings file) is reported on its row; the others are still removed.
    for (const r of plan) {
      try { await removeLocked(r.slug, r.kind === 'plugin' || !only ? {} : { from: r.harnesses.join(',') }, ctx); } catch (e) { r.error = e.message; }
    }
    return plan;
  };
  return opts.dryRun ? run() : withStateLock(ctx.dir, run);
}

export async function list(ctx) {
  return (await loadState(ctx.dir)).active;
}

export async function verify(ctx) {
  const state = await loadState(ctx.dir);
  const store = storeDir(ctx.dir);
  const problems = [];
  for (const e of state.active.filter((x) => x.kind === 'skill')) {
    const dir = path.join(store, e.sha256, e.slug);
    if (!(await exists(dir))) { problems.push(`${e.slug}: missing ${dir}`); continue; }
    if ((await hashDir(dir)) !== e.sha256) problems.push(`${e.slug}: modified on disk (${dir})`);
    for (const t of e.targets) {
      const s = await linkStatus(t.path, store);
      if (!s.exists || s.real !== (await realpathLoose(dir))) problems.push(`${e.slug}: ${t.path} does not point to ${dir}`);
    }
  }
  return problems;
}

export async function gc(ctx) {
  const store = storeDir(ctx.dir);
  if (!(await exists(store))) return [];
  const referenced = new Set((await loadState(ctx.dir)).active.map((e) => e.sha256).filter(Boolean));
  const removed = [];
  for (const name of await readdir(store)) {
    if (referenced.has(name)) continue;
    await rm(path.join(store, name), { recursive: true, force: true });
    if (!name.startsWith('.tmp-')) removed.push(name);
  }
  return removed;
}
