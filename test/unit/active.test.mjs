import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../helpers.mjs';
import { activeKeys, isActive, rawActiveKeys } from '../../cli/active.mjs';

async function world({ state = [], enabled, harnesses, homeDirs = [], cwdDirs = [] } = {}) {
  const home = await tempDir('sv-ahome-');
  const cwd = await tempDir('sv-acwd-');
  const dir = await tempDir('sv-astate-');
  await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, active: state.map((slug) => ({ slug, kind: 'skill', targets: [] })) }));
  if (enabled) {
    await fsp.mkdir(path.join(home, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
  }
  if (harnesses !== undefined) await fsp.writeFile(path.join(dir, 'harnesses.json'), harnesses);
  for (const rel of homeDirs) await fsp.mkdir(path.join(home, rel), { recursive: true });
  for (const rel of cwdDirs) await fsp.mkdir(path.join(cwd, rel), { recursive: true });
  return { home, cwd, dir };
}

const standalone = (slug) => ({ slug, kind: 'skill', plugin_slug: null });

test('a state entry marks the row active', async () => {
  const keys = await activeKeys(await world({ state: ['foo'] }));
  assert.equal(isActive(standalone('foo'), keys), true);
  assert.equal(isActive(standalone('bar'), keys), false);
});

test('an enabled plugin marks its plugin skill active; false does not', async () => {
  const keys = await activeKeys(await world({ enabled: { 'p@m': true, 'q@m': false } }));
  assert.equal(isActive({ slug: 'p@m:s', kind: 'skill', plugin_slug: 'p@m' }, keys), true);
  assert.equal(isActive({ slug: 'q@m:s', kind: 'skill', plugin_slug: 'q@m' }, keys), false);
  assert.equal(isActive({ slug: 'p@m', kind: 'plugin' }, keys), true);
});

test("an alternative's plugin being enabled marks the row active", async () => {
  const keys = await activeKeys(await world({ enabled: { 'p@m': true } }));
  assert.equal(isActive({ slug: 'x', kind: 'skill', plugin_slug: null, alternatives: ['p@m:s'] }, keys), true);
  assert.equal(isActive({ slug: 'x', kind: 'skill', plugin_slug: null, alternatives: ['z@m:s'] }, keys), false);
});

test('a standalone slug named like an entry of ~/.claude/skills is active', async () => {
  const keys = await activeKeys(await world({ homeDirs: ['.claude/skills/foo'] }));
  assert.ok(keys.dirs.includes('foo'));
  assert.equal(isActive(standalone('foo'), keys), true);
});

test('the project .claude/skills under cwd counts too', async () => {
  const keys = await activeKeys(await world({ cwdDirs: ['.claude/skills/local-one'] }));
  assert.equal(isActive(standalone('local-one'), keys), true);
});

test('another detected harness dir counts; an undetected one does not', async () => {
  const w = await world({ homeDirs: ['.codex/skills/cx', '.gemini/skills/gm'], harnesses: JSON.stringify({ version: 1, harnesses: ['codex'] }) });
  const keys = await activeKeys(w);
  assert.equal(isActive(standalone('cx'), keys), true);
  assert.equal(isActive(standalone('gm'), keys), false);
});

test('a plugin skill or plugin row is not matched by a directory of the same name', async () => {
  const keys = await activeKeys(await world({ homeDirs: ['.claude/skills/foo', '.claude/skills/pl'] }));
  assert.equal(isActive({ slug: 'foo', kind: 'skill', plugin_slug: 'p@m' }, keys), false);
  assert.equal(isActive({ slug: 'pl', kind: 'plugin' }, keys), false);
});

test('a symlink to a directory counts; a plain file does not', async () => {
  const w = await world({ homeDirs: ['.claude/skills'] });
  const target = await tempDir('sv-alink-');
  await fsp.symlink(target, path.join(w.home, '.claude', 'skills', 'linked'));
  await fsp.writeFile(path.join(w.home, '.claude', 'skills', 'notes.txt'), 'x');
  await fsp.symlink(path.join(target, 'missing'), path.join(w.home, '.claude', 'skills', 'dangling'));
  const keys = await activeKeys(w);
  assert.ok(keys.dirs.includes('linked'));
  assert.ok(!keys.dirs.includes('notes.txt'));
  assert.ok(!keys.dirs.includes('dangling'));
});

test('a corrupt harnesses.json falls back to the default harnesses without throwing', async () => {
  const keys = await activeKeys(await world({ harnesses: '{not json', homeDirs: ['.claude/skills/foo'] }));
  assert.equal(isActive(standalone('foo'), keys), true);
});

test('unreadable or missing directories are ignored', async () => {
  const keys = await activeKeys(await world());
  assert.deepEqual(keys.dirs, []);
  assert.deepEqual(keys.enabled, {});
});

test('rawActiveKeys lists state slugs, enabled plugins and dir names, sorted and unique', async () => {
  const keys = await activeKeys(await world({ state: ['zeta', 'dup'], enabled: { 'p@m': true, 'q@m': false }, homeDirs: ['.claude/skills/dup', '.claude/skills/alpha'] }));
  assert.deepEqual(rawActiveKeys(keys), ['alpha', 'dup', 'p@m', 'zeta']);
});
