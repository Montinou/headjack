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

// The marketplace installs the plugin from this package, so it must hold every path the plugin manifest uses: the
// skill directories, the hooks file, each `${CLAUDE_PLUGIN_ROOT}/...` file a hook or MCP server runs (with the import
// closure of a .mjs one), and the sqlite-vec loadables lib/local/vec.mjs looks for next to the CLI.
test('pack holds everything the plugin manifest uses', async () => {
  const out = path.join(await tempDir(), 'pkg');
  const written = new Set((await packNpm(out)).files);
  const plugin = await readJson('.claude-plugin/plugin.json');
  const rel = (p) => path.posix.normalize(p.replace('${CLAUDE_PLUGIN_ROOT}/', ''));
  const tree = async (dir) => (await walk(path.join(ROOT, dir))).map((f) => `${dir}/${f}`);

  const needed = [];
  for (const dir of plugin.skills.map(rel)) needed.push(...(await tree(dir)));
  const hooksFile = rel(plugin.hooks);
  needed.push(hooksFile);
  const commands = Object.values(plugin.mcpServers).map((s) => s.command);
  for (const groups of Object.values((await readJson(hooksFile)).hooks)) {
    for (const g of groups) for (const h of g.hooks) commands.push(h.command);
  }
  for (const c of commands) {
    for (const m of c.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
      needed.push(m[1]);
      if (m[1].endsWith('.mjs')) needed.push(...(await importGraph(m[1])).files);
    }
  }
  needed.push(...(await tree('cli/vendor')));

  assert.deepEqual(needed.filter((f) => !written.has(f)), [], 'paths the plugin uses that the package lacks');
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
  'cli/vendor/vec0.test.so': 'x',
  'skill-finder/SKILL.md': '# s',
  'writing-skills/SKILL.md': '# w',
  'plugin-hooks/hooks.json': '{"hooks":{}}',
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

test('the README documents the npm install', async () => {
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('npm install -g @triqual/headjack'), 'the global install');
  assert.match(readme, /"command":\s*"headjack",\s*"args":\s*\["mcp"\]/, 'the MCP client config');
  assert.ok(readme.includes('npx -y @triqual/headjack'), 'the npx trial');
});
