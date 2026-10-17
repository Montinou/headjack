#!/usr/bin/env node
// Guard: a change to a file the plugin ships must come with a plugin version change, so installed plugins update.
// Shipped = cli/headjack, the static import closure of cli/headjack.mjs, skill-finder/, plugin-hooks/ and .claude-plugin/.
//   node scripts/plugin-version-check.mjs --base <ref>     exit 0 when ok, 1 naming the first changed shipped file, 2 on usage
// Node built-ins plus git and tar; the closure walk comes from test/import-scanner.mjs, which ships in the public tree.
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { importGraph } from '../test/import-scanner.mjs';

const run = promisify(execFile);
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
const MAX_BUFFER = 1 << 28;

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = async (cwd, args) => (await run('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: MAX_BUFFER })).stdout;
// git archive and ls-tree are relative to the cwd, so every entry point works from the repository root.
const toplevel = async (cwd) => (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
const exists = async (cwd, ref, file) => {
  try {
    await git(cwd, ['cat-file', '-e', `${ref}:${file}`]);
    return true;
  } catch {
    return false;
  }
};

// `git archive <ref> | tar -x -C <dir>`, failing when either side does.
function extract(cwd, ref, dir) {
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', ref], { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const untar = spawn('tar', ['-x', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let failure = '';
    const done = [archive, untar].map((child, i) => {
      child.stderr.on('data', (chunk) => (failure += chunk));
      return new Promise((ok) => child.on('close', (code) => ok(code === 0 ? null : `${i === 0 ? 'git archive' : 'tar'} exited ${code}`)));
    });
    archive.on('error', reject);
    untar.on('error', reject);
    // An early tar exit closes its stdin (EPIPE): record it and let the exit codes reject, instead of an unhandled 'error'.
    for (const stream of [archive.stdout, untar.stdin]) stream.on('error', (error) => (failure += `${error.message}\n`));
    archive.stdout.pipe(untar.stdin);
    Promise.all(done).then((codes) => {
      const bad = codes.find(Boolean);
      if (bad) reject(new Error(`${bad} for ${ref}: ${failure.trim()}`));
      else resolve();
    });
  });
}

// The files the plugin ships at `ref`, sorted.
export async function shippedFiles({ cwd: from, ref }) {
  const cwd = await toplevel(from);
  const tmp = await mkdtemp(path.join(tmpdir(), 'plugin-version-'));
  try {
    await extract(cwd, ref, tmp);
    const files = new Set();
    if (await exists(cwd, ref, 'cli/headjack')) files.add('cli/headjack');
    if (await exists(cwd, ref, 'cli/headjack.mjs')) for (const f of (await importGraph('cli/headjack.mjs', { root: tmp })).files) files.add(f);
    const listed = await git(cwd, ['ls-tree', '-r', '-z', '--name-only', ref, '--', 'skill-finder', 'plugin-hooks', '.claude-plugin']);
    for (const f of listed.split('\0').filter(Boolean)) files.add(f);
    return [...files].sort();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function versionAt(cwd, ref) {
  return JSON.parse(await git(cwd, ['show', `${ref}:${PLUGIN_MANIFEST}`])).version;
}

// "major.minor.patch" as three integers, or null for anything else.
const parseSemver = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  return match ? match.slice(1).map(Number) : null;
};
// True when `head` is strictly greater than `base`; false when either is not semver.
const isGreater = (head, base) => {
  const [h, b] = [parseSemver(head), parseSemver(base)];
  if (!h || !b) return false;
  for (let i = 0; i < 3; i++) if (h[i] !== b[i]) return h[i] > b[i];
  return false;
};

// Counted files: shipped at the base or at the head (so a file that left the closure still counts), and changed between them.
// With one, the head version must be greater than the base's as semver; a non-semver value at either side fails.
export async function checkPluginVersion({ cwd: from, base, head = 'HEAD' }) {
  const cwd = await toplevel(from);
  const [baseVersion, headVersion] = [await versionAt(cwd, base), await versionAt(cwd, head)];
  const shipped = new Set([...(await shippedFiles({ cwd, ref: base })), ...(await shippedFiles({ cwd, ref: head }))]);
  const changed = (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`])).split('\0').filter(Boolean);
  const file = changed.filter((f) => shipped.has(f)).sort()[0];
  if (file === undefined || isGreater(headVersion, baseVersion)) return { ok: true, baseVersion, headVersion };
  return { ok: false, file, baseVersion, headVersion };
}

async function main(argv) {
  const at = argv.indexOf('--base');
  const base = at === -1 ? undefined : argv[at + 1];
  if (!base) {
    console.error('usage: node scripts/plugin-version-check.mjs --base <ref>');
    return 2;
  }
  const result = await checkPluginVersion({ cwd: process.cwd(), base });
  if (result.ok) {
    console.log(`plugin version ok: ${result.baseVersion} -> ${result.headVersion}`);
    return 0;
  }
  console.error(`::error file=${result.file}::${result.file} is shipped in the plugin and changed, but the plugin version did not increase (${result.baseVersion} -> ${result.headVersion} in ${PLUGIN_MANIFEST}); it must be a greater major.minor.patch.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}
