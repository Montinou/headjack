import { readdir, readFile, writeFile, realpath, access, lstat, rm, mkdir, cp, symlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, hashFiles, hashDir } from '../lib/hash.mjs';
import { pack } from '../lib/tar.mjs';
import { readSkillInfo, chunkSkill } from '../lib/skillmd.mjs';
import { findSkillDirs } from '../lib/find.mjs';
import { UserError } from '../lib/errors.mjs';
import { SLUG_RE } from '../lib/handlers.mjs';
import { scanFiles, findSecrets, excludedRootOf } from './scan.mjs';
import { excludedRootsFor, localConfigFor } from './local-config.mjs';
import { HARNESSES, KNOWN_HARNESSES, loadHarnesses, parseHarnessList, requireHarnessFilter, resolveHarnessDir } from './harness.mjs';
import { setPluginsEnabled } from './settings.mjs';
import { storeDir, linkStatus } from './install.mjs';
import { withStateLock } from './state.mjs';
import { MAX_TARBALL_BYTES } from './api.mjs';
import { confirm } from './prompt.mjs';

export const GRANDFATHERED = 'grandfathered: installed before the vault, not reviewed';

const exists = (p) => access(p).then(() => true, () => false);
const lexists = (p) => lstat(p).then(() => true, () => false);
const planPath = (ctx) => path.join(ctx.dir, 'import-plan.json');
const skillDirs = (home) => [path.join(home, '.agents', 'skills'), ...HARNESSES.map((h) => path.join(home, `.${h}`, 'skills'))];
const harnessSkillDir = (home, h) => path.join(home, KNOWN_HARNESSES[h].global);
const WORK_NOTE = 'under an excluded root: not uploaded';
const CORE_NOTE = 'core plugin: always loaded, its skills are not indexed';
const SINGLE_SKILL_NOTE = 'plugin with a single skill: the plugin row is enough';
// Notes the policy writes with upload: false. A re-plan recomputes these instead of carrying them forward.
const POLICY_NOTES = new Set([WORK_NOTE, CORE_NOTE, SINGLE_SKILL_NOTE]);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (e instanceof SyntaxError) throw new UserError(`${file} is corrupt: ${e.message}`);
    throw e;
  }
}

// Where a lockfile entry came from. For sourceType 'local' the source is a filesystem path (maybe relative to
// ~/.agents); it is resolved (realpath when it exists) so the excluded-root filter can see it.
async function lockOrigin(lk, home) {
  const raw = [lk.source, lk.sourceUrl].filter((v) => typeof v === 'string' && v);
  if (lk.sourceType !== 'local') return { origin: lk.sourceUrl ?? lk.source ?? null, paths: [] };
  const paths = [];
  for (const v of raw) {
    const abs = v.startsWith('file://') ? fileURLToPath(v) : path.resolve(path.join(home, '.agents'), v.replace(/^~(?=$|\/)/, home));
    paths.push(await realpath(abs).catch(() => abs));
  }
  return { origin: paths[0] ?? null, paths };
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

export async function planImport(ctx) {
  const lock = await readJson(path.join(ctx.home, '.agents', '.skill-lock.json'), { skills: {} });
  const realHome = await realpath(ctx.home).catch(() => ctx.home);
  // Each root carries both spellings of HOME, so a path that does not exist (and cannot be realpath'd) still matches.
  const roots = await excludedRootsFor(ctx);
  const isExcluded = (p) => excludedRootOf(p, roots) !== null;
  // Without corePlugins no plugin is core: each plugin's skills follow its upload choice.
  const core = (await localConfigFor(ctx)).corePlugins ?? [];
  const store = await realpath(storeDir(ctx.dir)).catch(() => storeDir(ctx.dir));
  const pluginCache = path.join(realHome, '.claude', 'plugins') + path.sep;
  const seen = new Set();
  const bySlug = new Map();
  const entries = [];

  for (const base of skillDirs(ctx.home)) {
    let names;
    try { names = await readdir(base); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const name of names.sort()) {
      if (name.startsWith('.') || name === 'skill-finder') continue;
      let real;
      try { real = await realpath(path.join(base, name)); } catch { continue; }
      if (seen.has(real) || real.startsWith(store + path.sep)) continue;
      if (!(await exists(path.join(real, 'SKILL.md')))) continue;
      seen.add(real);
      const lk = lock.skills?.[name];
      const from = lk ? await lockOrigin(lk, ctx.home) : null;
      const group = isExcluded(real) || from?.paths.some(isExcluded) ? 'work' : lk ? 'lock' : 'local';
      const entry = {
        slug: name, group, path: real,
        source: lk ? { kind: lk.sourceType === 'github' ? 'github' : 'git', url: lk.sourceUrl } : { kind: 'local' },
        source_path: lk?.skillPath ? path.posix.dirname(lk.skillPath) : null,
        upload: group === 'work' ? false : null,
      };
      if (from?.origin) entry.origin = from.origin;
      if (!SLUG_RE.test(name)) {
        entry.upload = false;
        entry.note = 'invalid slug';
      } else if (real.startsWith(pluginCache)) {
        entry.upload = false;
        entry.note = 'belongs to a plugin (indexed through the plugin)';
      } else if (bySlug.has(name)) {
        entry.upload = false;
        entry.note = `duplicate slug: already used by ${bySlug.get(name).path}`;
      } else {
        bySlug.set(name, entry);
      }
      entries.push(entry);
    }
  }
  // Plugin keys and plugin-skill slugs go through the same slug checks as standalone skills.
  const checkSlug = (entry) => {
    if (!SLUG_RE.test(entry.slug)) { entry.upload = false; entry.note = 'invalid slug'; }
    else if (bySlug.has(entry.slug)) { entry.upload = false; entry.note = `duplicate slug: already used by ${bySlug.get(entry.slug).path}`; }
    else bySlug.set(entry.slug, entry);
    entries.push(entry);
  };

  const installed = await readJson(path.join(ctx.home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: {} });
  for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
    const list = Array.isArray(installs) ? installs : [installs];
    const inst = list.find((i) => i.scope === 'user') ?? list[0];
    if (!inst?.installPath || !(await exists(inst.installPath))) continue;
    const marketplace = key.split('@')[1] ?? 'unknown';
    // A plugin installed under an excluded root (e.g. a `directory` marketplace) never leaves the machine.
    const work = isExcluded(await realpath(inst.installPath).catch(() => inst.installPath));
    checkSlug({
      slug: key, group: work ? 'work' : 'plugin', path: inst.installPath, version: inst.version ?? null, commit: inst.gitCommitSha ?? null,
      source: { kind: 'marketplace', url: marketplace }, upload: work ? false : null,
    });
    const skillDirsOfPlugin = (await findSkillDirs(inst.installPath)).filter((dir) => dir !== inst.installPath);
    // Search only needs per-skill rows where they help find something: a core plugin is always loaded, and a plugin
    // with a single skill is already found through its own row.
    const skipReason = core.includes(key) ? CORE_NOTE : skillDirsOfPlugin.length <= 1 ? SINGLE_SKILL_NOTE : null;
    for (const dir of skillDirsOfPlugin) {
      const entry = {
        slug: `${key}:${path.basename(dir)}`, group: work ? 'work' : 'plugin-skill', plugin_slug: key, path: dir,
        // null = follows its plugin's decision at import time (the plugin is confirmed once, not per skill).
        source: { kind: 'marketplace', url: marketplace }, upload: work || skipReason ? false : null,
      };
      if (!work && skipReason) entry.note = skipReason;
      checkSlug(entry);
    }
  }

  // Re-planning keeps what the previous plan recorded for the same slug and path: the user's answer (unless the scan
  // forces one), whether it was imported, its note and its hash. Otherwise a re-plan would make trim forget imports.
  // A skip the policy wrote (core, single-skill, excluded root) is recomputed, not carried; so is a former
  // excluded-root entry (group work), which older plans recorded without a note.
  const previous = await readJson(planPath(ctx), { entries: [] }).catch((e) => { if (e instanceof UserError) return { entries: [] }; throw e; });
  const prior = new Map((Array.isArray(previous?.entries) ? previous.entries : []).map((x) => [`${x.slug}\0${x.path}`, x]));
  for (const e of entries) {
    const old = prior.get(`${e.slug}\0${e.path}`);
    if (!old) continue;
    const policySkip = POLICY_NOTES.has(old.note) || old.group === 'work';
    if (e.upload === null && typeof old.upload === 'boolean' && !policySkip) e.upload = old.upload;
    if (old.imported === true && !(e.group === 'plugin-skill' && e.upload === false)) e.imported = true;
    if (e.note === undefined && old.note !== undefined && !policySkip) e.note = old.note;
    if (typeof old.sha256 === 'string') e.sha256 = old.sha256;
  }
  const plan = { generated_at: new Date().toISOString(), entries };
  await writeJson(planPath(ctx), plan);
  return plan;
}

async function buildManifest(e) {
  if (e.group === 'plugin') {
    const meta = await readJson(path.join(e.path, '.claude-plugin', 'plugin.json'), {});
    const description = meta.description || e.slug;
    const identity = Buffer.from(JSON.stringify({ key: e.slug, version: e.version, commit: e.commit }));
    return {
      manifest: {
        slug: e.slug, name: meta.name || e.slug.split('@')[0], description, kind: 'plugin', tags: [],
        source: e.source, commit_sha: e.commit, sha256: hashFiles([{ path: 'plugin.json', mode: 0o644, data: identity }]),
        status: 'approved', review_notes: 'plugin: enabled through enabledPlugins; content managed by its marketplace',
        scan_flags: [], chunks: [`${e.slug}: ${description}`],
      },
    };
  }
  if (e.group === 'plugin-skill') {
    const data = await readFile(path.join(e.path, 'SKILL.md'));
    const files = [{ path: 'SKILL.md', mode: 0o644, data }];
    const secrets = findSecrets(files);
    if (secrets.length) return { blocked: `secrets: ${secrets.map((s) => `${s.pattern} in ${s.file}:${s.line}`).join(', ')}` };
    const info = readSkillInfo(files, path.basename(e.path));
    return {
      manifest: {
        slug: e.slug, name: info.name, description: info.description, kind: 'skill', plugin_slug: e.plugin_slug, tags: [],
        source: e.source, commit_sha: null, sha256: hashFiles(files), status: 'approved',
        review_notes: 'plugin skill: activated by enabling the plugin', scan_flags: [], chunks: chunkSkill(info),
      },
    };
  }
  let files;
  try { files = await listFiles(e.path); } catch (err) { return { blocked: err.message }; }
  const secrets = findSecrets(files);
  if (secrets.length) return { blocked: `secrets: ${secrets.map((s) => `${s.pattern} in ${s.file}:${s.line}`).join(', ')}` };
  const info = readSkillInfo(files, e.slug);
  return {
    manifest: {
      slug: e.slug, name: info.name, description: info.description, kind: 'skill', tags: [],
      source: e.source, source_path: e.source_path, commit_sha: null, sha256: hashFiles(files),
      status: 'approved', review_notes: GRANDFATHERED, scan_flags: scanFiles(files), chunks: chunkSkill(info),
    },
    tarball: pack(files),
  };
}

export async function runImport(opts, ctx) {
  const file = planPath(ctx);
  const plan = await readJson(file, null);
  if (!plan) throw new UserError(`${file} does not exist; run first: headjack import --dry-run`);
  const bad = plan.entries.find((e) => e.upload !== true && e.upload !== false && e.upload !== null);
  if (bad) throw new UserError(`${bad.slug}: "upload" must be true, false or null in ${file} (it is ${JSON.stringify(bad.upload)})`);
  // Plugin skills inherit their plugin's answer, so only the plugin itself needs confirming.
  const pending = plan.entries.filter((e) => e.upload === null && e.group !== 'plugin-skill');
  const plugins = new Map(plan.entries.filter((e) => e.group === 'plugin').map((e) => [e.slug, e]));
  if (pending.length) {
    if (!opts.interactive) throw new UserError(`${pending.length} unconfirmed entries in ${file}: set "upload": true/false on each one or use --interactive`);
    for (const e of pending) {
      const skills = e.group === 'plugin' ? plan.entries.filter((x) => x.group === 'plugin-skill' && x.plugin_slug === e.slug).length : 0;
      const answer = await ctx.prompt(`Upload ${e.slug} (${e.group}, ${e.path}${e.origin ? `, origin ${e.origin}` : ''})${skills ? ` with its ${skills} skills` : ''}? [y/N] `);
      e.upload = confirm(answer);
    }
    await writeJson(file, plan);
  }

  const report = { published: [], existing: [], blocked: [], skipped: [], failed: [] };
  const roots = await excludedRootsFor(ctx);
  const isExcluded = (p) => excludedRootOf(p, roots) !== null;
  try {
    for (const e of plan.entries) {
      if (e.upload === false) { report.skipped.push(e.slug); continue; }
      if (e.group === 'plugin-skill' && plugins.get(e.plugin_slug)?.upload !== true) { report.skipped.push(e.slug); continue; }
      // Scope filter (spec §6.4) is enforced again at publish time: a hand-edited plan cannot upload excluded roots.
      if (e.group === 'work' || isExcluded(await realpath(e.path).catch(() => e.path))
        || (typeof e.origin === 'string' && path.isAbsolute(e.origin) && isExcluded(e.origin))) {
        e.upload = false;
        e.note = WORK_NOTE;
        report.skipped.push(e.slug);
        continue;
      }
      // One bad entry (unreadable dir, oversized tarball, API error) is reported and the run goes on.
      try {
        const built = await buildManifest(e);
        if (built.blocked) {
          report.blocked.push({ slug: e.slug, reason: built.blocked });
          e.upload = false;
          e.note = built.blocked;
          continue;
        }
        if (built.tarball && built.tarball.length > MAX_TARBALL_BYTES) throw new Error(`tarball too large (${built.tarball.length} bytes)`);
        try {
          await ctx.api.publish(built.manifest, built.tarball);
          report.published.push(e.slug);
        } catch (err) {
          if (err.status !== 409) throw err;
          // 409 = that (slug, sha256) exists, but maybe only as a rejected version: trim must not drop the only copy.
          if ((await ctx.api.getSkill(e.slug))?.sha256 !== built.manifest.sha256) throw new Error('a different or rejected version already exists');
          report.existing.push(e.slug);
        }
        e.imported = true;
        // The folder hash (= hashDir) lets trim recognise identical copies after the imported copy itself is gone.
        if (built.tarball) e.sha256 = built.manifest.sha256;
        delete e.note;
      } catch (err) {
        report.failed.push({ slug: e.slug, reason: err.message });
        e.note = err.message;
      }
    }
  } finally {
    await writeJson(file, plan);
  }
  return report;
}

// Per harness: which entries trim removes and which it keeps, with the reason. Only an imported lock/local entry
// goes, and only when it is the imported copy (realpath) or a byte-identical one outside excluded roots.
async function trimDecisions(plan, harnesses, ctx, { quiet }) {
  const realHome = await realpath(ctx.home).catch(() => ctx.home);
  const roots = await excludedRootsFor(ctx);
  const imported = new Map(plan.entries.filter((x) => x.imported && (x.group === 'lock' || x.group === 'local')).map((x) => [x.slug, x]));
  const planned = new Set(plan.entries.map((x) => x.slug));
  const importedHash = new Map();
  const store = storeDir(ctx.dir);
  const log = (m) => { if (!quiet) ctx.log(m); };
  const out = [];
  for (const h of harnesses) {
    const base = harnessSkillDir(ctx.home, h);
    if (!(await lexists(base))) continue;
    const report = { id: h, dir: base, symlinked: false, remove: [], keep: [] };
    out.push(report);
    if ((await realpath(base).catch(() => null)) !== harnessSkillDir(realHome, h)) {
      report.symlinked = true;
      log(`warning: ${base} is a symlink; not deleting through it`);
      continue;
    }
    for (const name of (await readdir(base)).sort()) {
      if (name.startsWith('.') || name === 'skill-finder') continue;
      const p = path.join(base, name);
      // A link into the store belongs to state.json (add/remove own it); removing it would leave a stale target.
      if ((await linkStatus(p, store)).managed) { report.keep.push({ path: p, reason: 'managed' }); continue; }
      const e = imported.get(name);
      if (!e) { report.keep.push({ path: p, reason: planned.has(name) ? 'not-imported' : 'not-in-vault' }); continue; }
      let real;
      try { real = await realpath(p); } catch { report.keep.push({ path: p, reason: 'broken' }); continue; }
      if (real !== e.path) {
        // A separate copy (e.g. a real dir with the same slug) goes only when it is byte-identical to the imported one:
        // its content is then in the vault and in the backup. Anything under an excluded root is never touched.
        if (excludedRootOf(real, roots) !== null) {
          log(`warning: ${p} is not the imported copy (${e.path}); keeping it`);
          report.keep.push({ path: p, reason: 'work-path' });
          continue;
        }
        if (!importedHash.has(e.slug)) importedHash.set(e.slug, await hashDir(e.path).catch(() => e.sha256 ?? null));
        const mine = await hashDir(real).catch(() => null);
        if (mine === null || mine !== importedHash.get(e.slug)) {
          log(`warning: ${p} differs from the imported copy (${e.path}); keeping it`);
          report.keep.push({ path: p, reason: 'differs' });
          continue;
        }
      }
      report.remove.push(p);
    }
  }
  return out;
}

// The real run holds the state lock, so add/remove/cleanup cannot change managed links under its decisions.
// Without a plan it fails (in trimRun) before creating anything.
export async function trim(opts, ctx) {
  if (opts.dryRun || !(await lexists(planPath(ctx)))) return trimRun(opts, ctx);
  return withStateLock(ctx.dir, () => trimRun(opts, ctx));
}

async function trimRun(opts, ctx) {
  const plan = await readJson(planPath(ctx), null);
  if (!plan) throw new UserError(`${planPath(ctx)} does not exist; run headjack import --dry-run and headjack import first`);
  const unfinished = plan.entries.filter((x) => x.upload === true && !x.imported).map((x) => x.slug);
  if (unfinished.length) throw new UserError(`not trimming: confirmed entries not imported yet: ${unfinished.join(', ')} (run headjack import again or set "upload": false)`);
  // Validate settings.json before touching anything, so a corrupt file cannot abort the trim half-way.
  const settings = path.join(ctx.home, '.claude', 'settings.json');
  const settingsData = (await exists(settings)) ? await readJson(settings) : null;
  if (settingsData !== null && (typeof settingsData !== 'object' || Array.isArray(settingsData))) throw new UserError(`${settings} is not a JSON object; not touching it`);
  const detected = await loadHarnesses(ctx);
  const targets = opts.onlyHarness != null ? parseHarnessList(requireHarnessFilter(opts.onlyHarness, '--only-harness'), detected) : detected;
  // Plugins live in Claude Code's settings: they are trimmed only when claude is one of the trimmed harnesses.
  const pluginsInScope = settingsData !== null && targets.includes('claude');
  // --keep adds to the configured core; naming a claude-mem replaces the configured one (spec §8.1: only one
  // claude-mem stays). With neither, plugins are left as they are.
  const extra = opts.keep ? opts.keep.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const { corePlugins } = await localConfigFor(ctx);
  const plugins = corePlugins === undefined && !extra.length ? 'untouched' : 'trimmed';
  const isMem = (k) => k.startsWith('claude-mem@');
  const keep = [...(corePlugins ?? []).filter((k) => !(isMem(k) && extra.some(isMem))), ...extra];
  // A core entry that matches no installed plugin (e.g. after a marketplace rename) would disable the plugin it meant
  // to keep: stop before the backup and before any write. Installed but disabled counts as installed.
  if (pluginsInScope && corePlugins?.length) {
    const installed = await readJson(path.join(ctx.home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: {} });
    const known = new Set([...Object.keys(settingsData.enabledPlugins ?? {}), ...Object.keys(installed?.plugins ?? {})]);
    const stale = corePlugins.filter((k) => !known.has(k));
    if (stale.length) throw new UserError(`corePlugins entries match no installed plugin: ${stale.join(', ')}; fix ${path.join(ctx.dir, 'config.json')} before trimming`);
  }
  const toDisable = pluginsInScope && plugins === 'trimmed'
    ? Object.entries(settingsData.enabledPlugins ?? {}).filter(([key, on]) => on && !keep.includes(key)).map(([key]) => key) : [];
  const roots = await excludedRootsFor(ctx);
  const finderTargets = [];
  for (const h of targets) {
    // Like the removals, skill-finder never goes through a symlinked harness dir, and never into an excluded root.
    const { dir, real, symlinked } = await resolveHarnessDir(h, ctx.home);
    if (symlinked || excludedRootOf(real, roots) !== null) continue;
    const p = path.join(dir, 'skill-finder');
    if (!(await lexists(p))) finderTargets.push(p);
  }

  const harnesses = await trimDecisions(plan, targets, ctx, { quiet: opts.dryRun });
  if (opts.dryRun) return { dryRun: true, harnesses, disabled: toDisable, finder: finderTargets, plugins };

  // The backup covers every detected harness dir (not only the trimmed ones), ~/.agents/skills and settings.json.
  const backup = path.join(ctx.dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const record = { created_at: new Date().toISOString(), dirs: [], settings: null };
  const bases = [path.join(ctx.home, '.agents', 'skills'), ...[...new Set([...detected, ...targets])].map((h) => harnessSkillDir(ctx.home, h))];
  for (const base of bases) {
    if (!(await lexists(base))) continue;
    await cp(base, path.join(backup, path.relative(ctx.home, base)), { recursive: true, verbatimSymlinks: true });
    record.dirs.push(base);
  }
  if (settingsData) {
    await mkdir(backup, { recursive: true });
    await copyFile(settings, path.join(backup, 'settings.json'));
    // restore puts settings.json back only when this trim may have changed it.
    if (pluginsInScope && plugins === 'trimmed') record.settings = settings;
  }
  await writeJson(path.join(backup, 'backup.json'), record);

  const removed = [];
  for (const r of harnesses) {
    for (const p of r.remove) {
      await rm(p, { recursive: true, force: true });
      removed.push(p);
    }
  }

  const disabled = [];
  const disabledWork = [];
  if (toDisable.length) {
    const work = new Set(plan.entries.filter((x) => x.group === 'work' && !x.plugin_slug).map((x) => x.slug));
    await setPluginsEnabled(settings, Object.fromEntries(toDisable.map((key) => [key, false])));
    for (const key of toDisable) {
      disabled.push(key);
      if (!work.has(key)) continue;
      disabledWork.push(key);
      ctx.log(`warning: work plugin disabled: ${key} (enable it in the repo's .claude/settings.json)`);
    }
  }

  const finderSrc = ctx.finderDir ?? fileURLToPath(new URL('../skill-finder', import.meta.url));
  const finder = [];
  for (const p of finderTargets) {
    if (await lexists(p)) continue;
    await mkdir(path.dirname(p), { recursive: true });
    await symlink(finderSrc, p, 'dir');
    finder.push(p);
  }
  return { backup, removed, disabled, disabledWork, finder, harnesses, plugins };
}

export async function restore(backupDir, ctx) {
  const record = await readJson(path.join(backupDir, 'backup.json'), null);
  if (!record) throw new UserError(`${backupDir} is not an headjack backup (backup.json is missing)`);
  const restored = [];
  const skipped = [];
  const failed = [];
  for (const base of record.dirs) {
    const src = path.join(backupDir, path.relative(ctx.home, base));
    try {
      // A base that was a symlink was never trimmed through (the backup holds the link itself, maybe relative).
      if ((await lstat(src)).isSymbolicLink()) { skipped.push(base); continue; }
      for (const name of await readdir(src)) {
        const dest = path.join(base, name);
        if (await lexists(dest)) continue;
        await mkdir(base, { recursive: true });
        await cp(path.join(src, name), dest, { recursive: true, verbatimSymlinks: true });
        restored.push(dest);
      }
    } catch (e) {
      // One bad dir does not stop the others; the caller reports it and exits non-zero.
      failed.push({ dir: base, reason: e.message });
    }
  }
  let settings = false;
  if (record.settings) {
    if (await exists(record.settings)) await copyFile(record.settings, `${record.settings}.pre-restore`);
    await copyFile(path.join(backupDir, 'settings.json'), record.settings);
    settings = true;
  }
  return { restored, skipped, failed, settings };
}
