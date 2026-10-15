// The plugin packaging around the CLI: manifest, launcher, README and the lazy-sqlite boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function inGitCheckout() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('the plugin manifest names headjack and points skills at a directory holding SKILL.md', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'headjack');
  assert.equal(typeof manifest.description, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.skills, './skill-finder');
  assert.ok(existsSync(path.join(ROOT, manifest.skills, 'SKILL.md')), 'skills must point at a directory with SKILL.md');
});

test('the manifest author is the name from LICENSE only, with no email, URL or repository', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  const holder = /^Copyright \(c\) \d{4} (.+)$/m.exec(read('LICENSE'))?.[1];
  assert.ok(holder, 'LICENSE carries a copyright holder');
  assert.deepEqual(manifest.author, { name: holder });
  assert.equal('repository' in manifest, false);
  assert.equal('homepage' in manifest, false);
  assert.doesNotMatch(JSON.stringify(manifest), /@|https?:\/\//);
});

test('bin/headjack is executable and committed with mode 100755', { skip: inGitCheckout() ? false : 'not a git checkout' }, () => {
  accessSync(path.join(ROOT, 'bin/headjack'), constants.X_OK);
  const entry = execFileSync('git', ['ls-files', '-s', 'bin/headjack'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(entry, /^100755 /);
});

test('the launcher works through a symlink, with a temporary HOME and no Node flags', async () => {
  const dir = await tempDir('sv-plugin-bin-');
  const home = await tempDir('sv-plugin-home-');
  const nested = path.join(dir, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  // A chain of two links, so the readlink loop has to resolve more than one hop.
  symlinkSync(path.join(ROOT, 'bin/headjack'), path.join(dir, 'a', 'first'));
  symlinkSync(path.join(dir, 'a', 'first'), path.join(nested, 'headjack'));
  const result = spawnSync(path.join(nested, 'headjack'), ['--help'], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^headjack/);
});

test('the launcher ignores CDPATH when it resolves its own directory', async () => {
  const dir = await tempDir('sv-plugin-cdpath-');
  const home = await tempDir('sv-plugin-home-');
  // A decoy: with CDPATH=<dir>, a plain `cd bin/..` would enter <dir>/bin/.. (<dir>) instead of the repository root.
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const result = spawnSync('sh', ['bin/headjack', '--help'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, CDPATH: dir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^headjack/);
});

test('the launcher finds the repository root when its bin/ directory is itself reached through a symlink', async () => {
  const dir = await tempDir('sv-plugin-linkedbin-');
  const home = await tempDir('sv-plugin-home-');
  mkdirSync(path.join(dir, 'linkedbin'), { recursive: true });
  // <dir>/linkedbin/bin -> <repo>/bin: a logical `..` would land in <dir>, a physical one in the repository.
  symlinkSync(path.join(ROOT, 'bin'), path.join(dir, 'linkedbin', 'bin'));
  const result = spawnSync(path.join(dir, 'linkedbin', 'bin', 'headjack'), ['--help'], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^headjack/);
});

test('the launcher passes arguments through and keeps the exit code', async () => {
  const home = await tempDir('sv-plugin-home-');
  const result = spawnSync(path.join(ROOT, 'bin/headjack'), ['no-such-command'], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command: no-such-command/);
});

test('git tracks the launcher and the plugin manifest', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  assert.ok(tracked.includes('bin/headjack'));
  assert.ok(tracked.includes('.claude-plugin/plugin.json'));
});

test('the README has Quickstart: local before Hosted (invite-only), and names HEADJACK_MODE and the Node requirement', () => {
  const readme = read('README.md');
  const local = readme.search(/^## Quickstart: local$/m);
  const hosted = readme.search(/^## Hosted \(invite-only\)$/m);
  assert.ok(local >= 0, 'Quickstart: local is missing');
  assert.ok(hosted > local, 'Hosted (invite-only) must come after Quickstart: local');
  assert.match(readme, /HEADJACK_MODE/);
  assert.match(readme, /Node 22\.16/);
  assert.match(readme, /ln -s .*bin\/headjack/);
});

test('skill-finder/SKILL.md does not rely on CLAUDE_PLUGIN_ROOT', () => {
  assert.doesNotMatch(read('skill-finder/SKILL.md'), /CLAUDE_PLUGIN_ROOT/);
});

test('only lib/local/ mentions node:sqlite among the files under cli/ and lib/', () => {
  const offenders = [];
  const walk = (rel) => {
    for (const name of readdirSync(path.join(ROOT, rel))) {
      const child = path.posix.join(rel, name);
      if (child === 'lib/local') continue;
      if (statSync(path.join(ROOT, child)).isDirectory()) walk(child);
      else if (/\.(mjs|js|ts|tsx)$/.test(name) && read(child).includes('node:sqlite')) offenders.push(child);
    }
  };
  walk('cli');
  walk('lib');
  assert.deepEqual(offenders, []);
});
