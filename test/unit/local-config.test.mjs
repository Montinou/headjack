import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { stateDir, loadLocalConfig, resolveExcludedRoots } from '../../cli/local-config.mjs';
import { UserError } from '../../lib/errors.mjs';
import { tempDir } from '../helpers.mjs';

test('stateDir defaults to ~/.headjack', () => {
  assert.equal(stateDir({ env: {}, home: '/h' }), '/h/.headjack');
  assert.equal(stateDir({ env: { HEADJACK_HOME: '' }, home: '/h' }), '/h/.headjack', 'empty counts as unset');
});

test('stateDir expands ~ and ~/ and drops a trailing slash', () => {
  const at = (HEADJACK_HOME) => stateDir({ env: { HEADJACK_HOME }, home: '/h' });
  assert.equal(at('~'), '/h');
  assert.equal(at('~/.sv/'), '/h/.sv');
  assert.equal(at('/abs/.sv/'), '/abs/.sv');
});

test('stateDir rejects a relative HEADJACK_HOME', () => {
  for (const value of ['.sv', '"~/.sv"']) {
    assert.throws(() => stateDir({ env: { HEADJACK_HOME: value }, home: '/h' }), (e) => e instanceof UserError && /HEADJACK_HOME must be an absolute path/.test(e.message) && e.message.includes(`(got "${value}")`), value);
  }
});

test('loadLocalConfig: missing file is {}; {} and unknown keys are fine', async () => {
  const dir = await tempDir('sv-cfg-');
  assert.deepEqual(await loadLocalConfig(path.join(dir, 'nowhere')), {});
  await writeFile(path.join(dir, 'config.json'), '{}');
  assert.deepEqual(await loadLocalConfig(dir), {});
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ futureKey: 1, excludedRoots: ['~/acme-work'], corePlugins: ['a@b'] }));
  assert.deepEqual(await loadLocalConfig(dir), { excludedRoots: ['~/acme-work'], corePlugins: ['a@b'] });
});

test('loadLocalConfig: invalid JSON, an array, and excludedRoots: "x" each throw naming the file', async () => {
  const dir = await tempDir('sv-cfg-');
  const file = path.join(dir, 'config.json');
  for (const content of ['not json', '[]', 'null', '"x"']) {
    await writeFile(file, content);
    await assert.rejects(loadLocalConfig(dir), (e) => e instanceof UserError && e.message === `${file}: not a valid JSON object`, content);
  }
  for (const [key, value] of [['excludedRoots', 'x'], ['excludedRoots', [1]], ['corePlugins', null]]) {
    await writeFile(file, JSON.stringify({ [key]: value }));
    await assert.rejects(loadLocalConfig(dir), (e) => e instanceof UserError && e.message === `${file}: "${key}" must be an array of strings`, key);
  }
});

test('resolveExcludedRoots: env wins over config; empty or delimiter-only env counts as unset', async () => {
  const home = await tempDir('sv-home-');
  const config = { excludedRoots: ['~/from-config'] };
  const written = async (env) => (await resolveExcludedRoots({ env, home, config })).map((r) => r.written);
  assert.deepEqual(await written({ HEADJACK_EXCLUDED_ROOTS: ['~/a', '', '/abs/b'].join(path.delimiter) }), ['~/a', '/abs/b']);
  assert.deepEqual(await written({ HEADJACK_EXCLUDED_ROOTS: '' }), ['~/from-config']);
  // Only delimiters (e.g. "$A:$B" with both unset) is unset too: it must not silently drop the configured roots.
  assert.deepEqual(await written({ HEADJACK_EXCLUDED_ROOTS: path.delimiter }), ['~/from-config']);
  assert.deepEqual(await written({ HEADJACK_EXCLUDED_ROOTS: path.delimiter.repeat(3) }), ['~/from-config']);
  assert.deepEqual(await resolveExcludedRoots({ env: { HEADJACK_EXCLUDED_ROOTS: ':' }, home, config: { excludedRoots: ['~/acme-work'] } }).then((r) => r.map((x) => x.written)), ['~/acme-work']);
  assert.deepEqual(await written({}), ['~/from-config']);
  assert.deepEqual(await resolveExcludedRoots({ env: {}, home, config: {} }), [], 'nothing is excluded by default');
  const [root] = await resolveExcludedRoots({ env: {}, home, config: { excludedRoots: ['~/Acme-Work/'] } });
  assert.ok(root.forms.includes(path.join(home, 'acme-work').toLowerCase()), root.forms.join(','));
  assert.ok(root.forms.every((f) => f === f.toLowerCase() && !f.endsWith(path.sep)), root.forms.join(','));
});

test('resolveExcludedRoots: relative entry throws', async () => {
  const home = await tempDir('sv-home-');
  for (const entry of ['acme-work', '~acme', './x']) {
    await assert.rejects(resolveExcludedRoots({ env: {}, home, config: { excludedRoots: [entry] } }),
      (e) => e instanceof UserError && e.message === `excluded root "${entry}" must be absolute or start with ~/`, entry);
  }
  await assert.rejects(resolveExcludedRoots({ env: { HEADJACK_EXCLUDED_ROOTS: 'rel' }, home, config: {} }), /excluded root "rel" must be absolute/);
});
