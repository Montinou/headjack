import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importGraph } from '../import-scanner.mjs';
import { makeDir, tempDir } from '../helpers.mjs';
import { packNpm, BY_PATH } from '../../scripts/pack-npm.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async (rel) => JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));

// Every file under `dir`, relative to `dir`.
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

test('versions agree', async () => {
  const manifest = await readJson('npm/package.json');
  const plugin = await readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.version, plugin.version);
  assert.equal(manifest.name, '@triqual/headjack');
  assert.deepEqual(manifest.bin, { headjack: 'cli/headjack.mjs' });
  assert.equal(manifest.engines?.node, '>=22.16');
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.equal(manifest.repository?.url, 'git+https://github.com/Montinou/headjack.git');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.description, plugin.description);
  assert.ok(manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0, 'no dependencies');
});

test('pack copies the closure and the by-path files', async () => {
  const out = path.join(await tempDir(), 'pkg');
  const { files } = await packNpm(out);
  const written = await walk(out);
  assert.deepEqual([...files].sort(), written, 'packNpm reports what it wrote');

  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'package.json'), 'utf8')), await readJson('npm/package.json'));
  for (const f of ['README.md', 'LICENSE', '.claude-plugin/plugin.json', 'cli/headjack']) assert.ok(written.includes(f), f);
  for (const f of (await importGraph('cli/headjack.mjs')).files) assert.ok(written.includes(f), f);
  for (const f of await walk(path.join(ROOT, 'skill-finder'))) assert.ok(written.includes(`skill-finder/${f}`), f);
  assert.ok((await stat(path.join(out, 'cli/headjack'))).mode & 0o111, 'the launcher stays executable');
  assert.deepEqual(written.filter((f) => /^(app|db|test)\//.test(f)), []);
});

test('pack refuses a non-empty output directory', async () => {
  const out = await makeDir({ 'stale.txt': 'x' });
  await assert.rejects(packNpm(out), /not empty/);
});

// The smallest tree packNpm reads, with `extra` files on top.
const fakeRoot = (extra) => makeDir({
  'npm/package.json': '{"name":"@triqual/headjack","version":"0.0.0"}',
  'README.md': '# r',
  LICENSE: 'MIT',
  '.claude-plugin/plugin.json': '{"version":"0.0.0"}',
  'cli/headjack': { content: '#!/bin/sh\n', mode: 0o755 },
  'skill-finder/SKILL.md': '# s',
  ...extra,
});

test('pack refuses an escape', async () => {
  const pkgRoot = await fakeRoot({ 'cli/headjack.mjs': "import pad from 'left-pad';\nimport 'node:fs';\n" });
  await assert.rejects(packNpm(path.join(await tempDir(), 'pkg'), { root: pkgRoot }), /left-pad/);

  const escRoot = await fakeRoot({
    'cli/headjack.mjs': "import './x.mjs';\n",
    'cli/x.mjs': 'const name = "y";\nawait import(name);\n',
  });
  await assert.rejects(packNpm(path.join(await tempDir(), 'pkg'), { root: escRoot }), /cli\/x\.mjs:2/);

  const okRoot = await fakeRoot({ 'cli/headjack.mjs': "import 'node:fs';\n" });
  const { files } = await packNpm(path.join(await tempDir(), 'pkg'), { root: okRoot });
  assert.ok(files.includes('cli/headjack.mjs'), 'a root of node: built-ins only packs');
});

test('every by-path construction is listed', async () => {
  const closure = new Set((await importGraph('cli/headjack.mjs')).files);
  const covered = (rel) => closure.has(rel) || BY_PATH.some((p) => rel === p || rel.startsWith(`${p}/`));
  const found = [];
  for (const name of (await readdir(path.join(ROOT, 'cli'))).filter((n) => n.endsWith('.mjs'))) {
    const src = await readFile(path.join(ROOT, 'cli', name), 'utf8');
    for (const m of src.matchAll(/new URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
      const rel = path.relative(ROOT, path.resolve(ROOT, 'cli', m[2])).split(path.sep).join('/');
      found.push(rel);
      assert.ok(covered(rel), `cli/${name} builds a path to ${rel}, which the pack list does not cover`);
    }
  }
  assert.ok(found.includes('.claude-plugin/plugin.json') && found.includes('skill-finder'), 'the scan sees the known constructions');
});
