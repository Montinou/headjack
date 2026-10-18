#!/usr/bin/env node
// Builds the @triqual/headjack package directory: npm/package.json (as package.json), README.md, LICENSE, the static
// import closure of cli/headjack.mjs and the files the CLI reads or runs by path (BY_PATH), all at their repository paths.
//   node scripts/pack-npm.mjs <out-dir>     exit 0 when packed, 1 on a refused closure or a copy failure, 2 on usage
// Refuses a closure that imports anything but node: built-ins, or holds a line the static scan cannot follow.
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importGraph, escapesScan, ROOT } from '../test/import-scanner.mjs';

const ENTRY = 'cli/headjack.mjs';

// Files the CLI reaches through `new URL(..., import.meta.url)` instead of an import: the manifest pluginVersion() reads
// for the MCP serverInfo.version, the launcher `suggest` and the hook name, and the skill-finder directory `import`
// links into each harness. A directory is copied whole.
export const BY_PATH = ['.claude-plugin/plugin.json', 'cli/headjack', 'skill-finder'];

async function listFiles(root, rel) {
  const out = [];
  for (const entry of await readdir(path.join(root, rel), { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory()) out.push(path.relative(root, path.join(entry.parentPath, entry.name)));
  }
  return out;
}

async function isEmptyOrMissing(dir) {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

export async function packNpm(outDir, { root = ROOT } = {}) {
  const { files: closure, external } = await importGraph(ENTRY, { root });
  const packages = external.filter((s) => !s.startsWith('node:'));
  if (packages.length) throw new Error(`the CLI closure imports something other than node: built-ins: ${packages.join(', ')}`);
  for (const f of closure) {
    const lines = (await readFile(path.join(root, f), 'utf8')).split('\n');
    const at = lines.findIndex(escapesScan);
    if (at !== -1) throw new Error(`${f}:${at + 1} has a computed import(), a require( or createRequire, which the closure scan cannot follow`);
  }
  if (!(await isEmptyOrMissing(outDir))) throw new Error(`${outDir} is not empty`);

  const copies = [['npm/package.json', 'package.json'], ['README.md', 'README.md'], ['LICENSE', 'LICENSE']];
  for (const f of closure) copies.push([f, f]);
  for (const p of BY_PATH) for (const f of (await stat(path.join(root, p))).isDirectory() ? await listFiles(root, p) : [p]) copies.push([f, f]);

  const written = new Set();
  for (const [from, to] of copies) {
    if (written.has(to)) continue;
    await mkdir(path.dirname(path.join(outDir, to)), { recursive: true });
    // fs.cp keeps the source's mode, so cli/headjack stays executable.
    await cp(path.join(root, from), path.join(outDir, to), { errorOnExist: true, force: false });
    written.add(to);
  }
  return { files: [...written].sort() };
}

async function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    console.error('usage: node scripts/pack-npm.mjs <out-dir>');
    return 2;
  }
  const { files } = await packNpm(path.resolve(argv[0]));
  console.log(`packed ${files.length} files into ${argv[0]}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`pack-npm: ${error.message}`);
      process.exit(1);
    },
  );
}
