// The plugin version guard: a change to a file the plugin ships (cli/headjack, the CLI import closure, skill-finder/,
// .claude-plugin/) must come with a plugin version change. Each case runs against a throwaway git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginVersion, shippedFiles } from '../../scripts/plugin-version-check.mjs';
import { makeDir } from '../helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/plugin-version-check.mjs', import.meta.url));

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: cleanEnv(), encoding: 'utf8' });

const manifest = (version) => JSON.stringify({ name: 'headjack', version }) + '\n';

// main: a plugin whose closure is cli/headjack.mjs -> lib/a.mjs, plus a docs file. `feature` branches from it.
async function fixture(overrides = {}) {
  const cwd = await makeDir({
    'cli/headjack': '#!/bin/sh\nexec node cli/headjack.mjs\n',
    'cli/headjack.mjs': "import '../lib/a.mjs';\n",
    'lib/a.mjs': "import './b.mjs';\nexport const a = 1;\n",
    'lib/b.mjs': 'export const b = 1;\n',
    'lib/unshipped.mjs': 'export const u = 1;\n',
    'skill-finder/SKILL.md': '# skill\n',
    'plugin-hooks/hooks.json': '{}\n',
    '.claude-plugin/plugin.json': manifest('0.3.0'),
    'docs/x.md': 'docs\n',
    ...overrides,
  });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  git(cwd, 'checkout', '-q', '-b', 'feature');
  return cwd;
}

async function commit(cwd, message = 'change') {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

test('shippedFiles lists the launcher, the CLI closure, skill-finder, plugin-hooks and the plugin manifest', async () => {
  const cwd = await fixture();
  assert.deepEqual(await shippedFiles({ cwd, ref: 'main' }), [
    '.claude-plugin/plugin.json',
    'cli/headjack',
    'cli/headjack.mjs',
    'lib/a.mjs',
    'lib/b.mjs',
    'plugin-hooks/hooks.json',
    'skill-finder/SKILL.md',
  ]);
});

test('no shipped change is ok', async () => {
  const cwd = await fixture();
  const res = await checkPluginVersion({ cwd, base: 'main' });
  assert.deepEqual(res, { ok: true, baseVersion: '0.3.0', headVersion: '0.3.0' });
});

test('a closure file changed without a version bump is not ok and names the file', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'lib/b.mjs'), 'export const b = 2;\n');
  await commit(cwd);
  const res = await checkPluginVersion({ cwd, base: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.file, 'lib/b.mjs');
  assert.equal(res.baseVersion, '0.3.0');
  assert.equal(res.headVersion, '0.3.0');
});

test('the same change with the version 0.3.0 -> 0.3.1 is ok', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'lib/b.mjs'), 'export const b = 2;\n');
  await writeFile(path.join(cwd, '.claude-plugin/plugin.json'), manifest('0.3.1'));
  await commit(cwd);
  const res = await checkPluginVersion({ cwd, base: 'main' });
  assert.deepEqual(res, { ok: true, baseVersion: '0.3.0', headVersion: '0.3.1' });
});

// A shipped change plus a head version; the result is checked against the base 0.3.0.
async function bumped(version) {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'lib/b.mjs'), 'export const b = 2;\n');
  await writeFile(path.join(cwd, '.claude-plugin/plugin.json'), manifest(version));
  await commit(cwd);
  return checkPluginVersion({ cwd, base: 'main' });
}

test('a shipped change must raise the version as semver: 0.3.0 -> 0.2.9 is not ok', async () => {
  const res = await bumped('0.2.9');
  assert.equal(res.ok, false);
  assert.equal(res.file, '.claude-plugin/plugin.json', 'the manifest is itself shipped and sorts first');
  assert.equal(res.headVersion, '0.2.9');
});

test('a shipped change with the same version string, or a lower patch, is not ok', async () => {
  assert.equal((await bumped('0.3.0')).ok, false);
  assert.equal((await bumped('0.2.99')).ok, false);
});

test('a non-semver head version fails with a shipped change', async () => {
  for (const bad of ['banana', '1.0', '1.0.0.0', '1.x.0', '']) assert.equal((await bumped(bad)).ok, false, `head ${JSON.stringify(bad)}`);
});

test('a non-semver base version fails with a shipped change', async () => {
  const cwd = await fixture({ '.claude-plugin/plugin.json': manifest('banana') });
  await writeFile(path.join(cwd, 'lib/b.mjs'), 'export const b = 2;\n');
  await writeFile(path.join(cwd, '.claude-plugin/plugin.json'), manifest('0.3.1'));
  await commit(cwd);
  assert.equal((await checkPluginVersion({ cwd, base: 'main' })).ok, false);
});

test('0.3.0 -> 0.3.1 and 0.3.0 -> 0.10.0 are ok; the comparison is numeric, not lexical', async () => {
  assert.equal((await bumped('0.3.1')).ok, true);
  assert.equal((await bumped('0.10.0')).ok, true);
  assert.equal((await bumped('1.0.0')).ok, true);
});

test('a change only to docs/x.md or a file outside the closure is ok', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'docs/x.md'), 'changed\n');
  await writeFile(path.join(cwd, 'lib/unshipped.mjs'), 'export const u = 2;\n');
  await commit(cwd);
  assert.equal((await checkPluginVersion({ cwd, base: 'main' })).ok, true);
});

test('a file removed from the closure at head still counts', async () => {
  // closure at main: cli -> z -> a. At head z stops importing a, and a is deleted: a is no longer shipped, but its removal is a
  // shipped change, and it sorts before z, so a head-only closure would name z instead.
  const cwd = await fixture({
    'cli/headjack.mjs': "import '../lib/z.mjs';\n",
    'lib/z.mjs': "import './a.mjs';\n",
    'lib/a.mjs': 'export const a = 1;\n',
  });
  await writeFile(path.join(cwd, 'lib/z.mjs'), 'export const z = 1;\n');
  await rm(path.join(cwd, 'lib/a.mjs'));
  await commit(cwd);
  assert.ok(!(await shippedFiles({ cwd, ref: 'HEAD' })).includes('lib/a.mjs'));
  const res = await checkPluginVersion({ cwd, base: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.file, 'lib/a.mjs');
});

test('the CLI exits 0 when ok and 1 naming the first changed shipped file otherwise', async () => {
  const cwd = await fixture();
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  assert.equal(run('--base', 'main').code, 0);
  await writeFile(path.join(cwd, 'skill-finder/SKILL.md'), '# changed\n');
  await commit(cwd);
  const failed = run('--base', 'main');
  assert.equal(failed.code, 1);
  assert.match(failed.out, /skill-finder\/SKILL\.md/);
  assert.equal(run().code, 2, 'no --base is a usage error');
});

test('the CLI works from a subdirectory of the repository', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'lib/b.mjs'), 'export const b = 2;\n');
  await commit(cwd);
  const sub = path.join(cwd, 'docs');
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [SCRIPT, '--base', 'main'], { cwd: sub, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status;
    out = `${e.stdout}${e.stderr}`;
  }
  assert.equal(code, 1, out);
  assert.match(out, /lib\/b\.mjs/);
  assert.deepEqual((await shippedFiles({ cwd: sub, ref: 'main' })).includes('lib/b.mjs'), true, 'shippedFiles also resolves the repository root');
});

test('a change under plugin-hooks/ without a version bump is not ok and names the file; with a bump it is ok', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'plugin-hooks/hooks.json'), '{"hooks":{}}\n');
  await commit(cwd);
  const res = await checkPluginVersion({ cwd, base: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.file, 'plugin-hooks/hooks.json');
  await writeFile(path.join(cwd, '.claude-plugin/plugin.json'), manifest('0.3.1'));
  await commit(cwd, 'bump');
  assert.equal((await checkPluginVersion({ cwd, base: 'main' })).ok, true);
});
