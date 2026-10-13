import { mkdir, rm, cp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, hashFiles } from '../lib/hash.mjs';
import { pack, unpack, writeFiles } from '../lib/tar.mjs';
import { readSkillInfo, chunkSkill } from '../lib/skillmd.mjs';
import { findSkillDirs } from '../lib/find.mjs';
import { parseGithub } from '../lib/upstream.mjs';
import { SLUG_RE } from '../lib/handlers.mjs';
import { UserError, EofError } from '../lib/errors.mjs';
import { scanFiles, findSecrets, isBinary, excludedRootOf } from './scan.mjs';
import { excludedRootsFor } from './local-config.mjs';
import { MAX_TARBALL_BYTES } from './api.mjs';
import { askYesNo } from './prompt.mjs';

const REMOTE_RE = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/;

// Refuses a local source (a path or a file:// URL, compared by realpath) under an excluded root.
function refuseExcluded(real, roots) {
  const root = excludedRootOf(real, roots);
  if (root !== null) throw new UserError(`${real} is under an excluded root (${root}); it is not uploaded`);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// realpath for a local source; a path that is not there is the user's mistake, not a crash.
async function realSource(p) {
  try { return await realpath(p); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new UserError(`no such path: ${p}`);
    throw e;
  }
}

async function fetchSource(source, staging, ctx) {
  const roots = await excludedRootsFor(ctx);
  if (REMOTE_RE.test(source)) {
    if (source.startsWith('file://')) refuseExcluded(await realSource(fileURLToPath(source)), roots);
    const repoDir = path.join(staging, 'repo');
    const clone = await ctx.exec('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--quiet', source, repoDir]);
    if (clone.code !== 0) throw new UserError(`git clone failed: ${clone.stderr.trim()}`);
    const commit = (await ctx.exec('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).stdout.trim();
    const gh = parseGithub(source);
    const name = gh?.repo ?? path.basename(source).replace(/\.git$/, '');
    return { root: repoDir, meta: { kind: gh ? 'github' : 'git', url: source, default_ref: 'HEAD' }, commit, name, remote: true };
  }
  const real = await realSource(source);
  refuseExcluded(real, roots);
  const root = path.join(staging, 'local');
  await cp(real, root, { recursive: true, verbatimSymlinks: true });
  return { root, meta: { kind: 'local' }, commit: null, name: path.basename(real), remote: false };
}

async function chooseSkills(root, ctx) {
  const dirs = await findSkillDirs(root);
  if (!dirs.length) throw new UserError('no SKILL.md found in the source');
  if (dirs.length === 1) return dirs;
  dirs.forEach((d, i) => ctx.log(`  ${i + 1}) ${path.relative(root, d) || '.'}`));
  const answer = (await ctx.prompt('Which ones to review? (comma-separated numbers, or "all"): ')).trim().toLowerCase();
  if (answer === 'all') return dirs;
  const picked = answer.split(',').map((s) => Number(s.trim()) - 1);
  if (picked.some((i) => !Number.isInteger(i) || !dirs[i])) throw new UserError(`invalid selection: ${answer}`);
  return picked.map((i) => dirs[i]);
}

function printFlags(flags, previous, log) {
  if (!flags.length) { log('  scan: no flags'); return; }
  const seen = new Set(previous.map((f) => `${f.rule}|${f.file}`));
  for (const f of flags) {
    const tag = seen.has(`${f.rule}|${f.file}`) ? '' : ' [NEW]';
    log(`  [${f.severity}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''}${f.match ? `  ${f.match}` : ''}${tag}`);
  }
}

async function resolveSubdir(root, sub) {
  const target = path.resolve(root, sub);
  const realTarget = isInside(root, target) ? await realpath(target).catch(() => target) : null;
  if (!realTarget || !isInside(await realpath(root), realTarget)) throw new UserError(`--path is outside the source: ${sub}`);
  return target;
}

async function showDiff(slug, files, staging, ctx) {
  const { tarball } = await ctx.api.download(slug);
  const before = unpack(tarball);
  const prevBy = new Map(before.map((f) => [f.path, f]));
  const curBy = new Map(files.map((f) => [f.path, f]));
  const added = files.filter((f) => !prevBy.has(f.path)).map((f) => f.path);
  const deleted = before.filter((f) => !curBy.has(f.path)).map((f) => f.path);
  const modified = files.filter((f) => {
    const p = prevBy.get(f.path);
    return p && (p.mode !== f.mode || !p.data.equals(f.data));
  }).map((f) => f.path);
  if (added.length) ctx.log(`  added: ${added.join(', ')}`);
  if (deleted.length) ctx.log(`  deleted: ${deleted.join(', ')}`);
  if (modified.length) ctx.log(`  modified: ${modified.join(', ')}`);
  const tag = slug.replace(/[^A-Za-z0-9._-]/g, '_');
  const prev = path.join(staging, `prev-${tag}`);
  const cur = path.join(staging, `cur-${tag}`);
  await mkdir(prev, { recursive: true });
  await mkdir(cur, { recursive: true });
  await writeFiles(prev, before);
  await writeFiles(cur, files);
  const diff = await ctx.exec('git', ['diff', '--no-index', '--no-color', prev, cur]);
  ctx.log(diff.stdout.trim() || '(no content differences)');
}

async function reviewOne(dir, origin, staging, opts, ctx) {
  const rel = path.relative(origin.root, dir);
  let files;
  try { files = await listFiles(dir); } catch (e) {
    ctx.log(`✗ ${rel || '.'}: ${e.message}`);
    return { slug: null, outcome: 'error' };
  }
  const folder = rel ? path.basename(dir) : origin.name;
  const slug = opts.slug ?? folder;
  if (!SLUG_RE.test(slug)) {
    ctx.log(`✗ invalid slug "${slug}"; use --slug`);
    return { slug: null, outcome: 'error' };
  }
  try {
    return await decide(slug, folder, rel, files, origin, staging, ctx);
  } catch (e) {
    if (e instanceof EofError) throw e; // no more answers for this or any later skill
    ctx.log(`✗ ${slug}: ${e.message}`);
    return { slug, outcome: 'error' };
  }
}

async function decide(slug, folder, rel, files, origin, staging, ctx) {
  const info = readSkillInfo(files, folder);
  const sha256 = hashFiles(files);
  const flags = scanFiles(files);
  const secrets = findSecrets(files);
  ctx.log(`\n== ${slug} (${rel || '.'}) sha256 ${sha256.slice(0, 12)}`);

  if (await askYesNo(ctx, 'Does it contain work or client content? [y/n] ')) {
    ctx.log('not published (work content)');
    return { slug, outcome: 'skipped-scope' };
  }
  if (secrets.length) {
    for (const s of secrets) ctx.log(`  secret ${s.pattern} in ${s.file}:${s.line}`);
    ctx.log('✗ blocked: remove the secrets and run review again');
    return { slug, outcome: 'blocked-secrets' };
  }

  const current = await ctx.api.getSkill(slug);
  if (current && (current.kind === 'plugin' || current.plugin_slug)) {
    ctx.log(`✗ ${slug}: the slug belongs to a plugin; it is not reviewed as a standalone skill`);
    return { slug, outcome: 'error' };
  }
  if (current) {
    if (current.sha256 === sha256) {
      ctx.log('no changes from the approved version');
      return { slug, outcome: 'unchanged' };
    }
    const prior = (await ctx.api.versions(slug)).find((v) => v.sha256 === sha256);
    if (prior?.status === 'rejected') {
      ctx.log(`this version was already rejected: ${prior.review_notes ?? '(no notes)'}`);
      return { slug, outcome: 'previously-rejected' };
    }
  }
  printFlags(flags, current?.scan_flags ?? [], ctx.log);
  if (current?.sha256) await showDiff(slug, files, staging, ctx);
  else ctx.log('new skill (no previously approved version)');

  const base = {
    slug, name: info.name, description: info.description, kind: 'skill', tags: [],
    source: origin.meta, source_path: origin.remote && rel ? rel : null, commit_sha: origin.commit, sha256, scan_flags: flags,
  };
  for (;;) {
    const action = (await ctx.prompt('[a]pprove / [r]eject / [v]iew file / [q]uit: ')).trim().toLowerCase();
    if (action === 'q') return { slug, outcome: 'skipped' };
    if (action === 'v') {
      const name = (await ctx.prompt('file: ')).trim();
      const hit = files.find((f) => f.path === name);
      ctx.log(hit ? (isBinary(hit.data) ? '(binary)' : hit.data.toString('utf8')) : `no file ${name}; files: ${files.map((f) => f.path).join(', ')}`);
      continue;
    }
    if (action === 'a') {
      const tarball = pack(files);
      if (tarball.length > MAX_TARBALL_BYTES) {
        ctx.log(`✗ ${slug}: tarball too large (${tarball.length} bytes)`);
        return { slug, outcome: 'error' };
      }
      if (flags.some((f) => f.severity === 'high')) {
        const typed = (await ctx.prompt(`There are high flags. Type "${slug}" to confirm: `)).trim();
        if (typed !== slug) { ctx.log('does not match; not approved'); continue; }
      }
      const notes = (await ctx.prompt('Review notes: ')).trim();
      await ctx.api.publish({ ...base, status: 'approved', review_notes: notes || null, chunks: chunkSkill(info) }, tarball);
      ctx.log(`✓ ${slug} published`);
      return { slug, outcome: 'approved' };
    }
    if (action === 'r') {
      const notes = (await ctx.prompt('Rejection reason: ')).trim();
      await ctx.api.publish({ ...base, status: 'rejected', review_notes: notes || null, chunks: [] });
      ctx.log(`✓ ${slug} recorded as rejected`);
      return { slug, outcome: 'rejected' };
    }
  }
}

export async function review(source, opts, ctx) {
  const staging = path.join(ctx.dir, 'staging', `${Date.now()}-${process.pid}`);
  await mkdir(staging, { recursive: true });
  try {
    const origin = await fetchSource(source, staging, ctx);
    const dirs = opts.path ? [await resolveSubdir(origin.root, opts.path)] : await chooseSkills(origin.root, ctx);
    const results = [];
    for (const dir of dirs) results.push(await reviewOne(dir, origin, staging, opts, ctx));
    return results;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
