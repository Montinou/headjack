import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { SUGGEST_DEFAULTS, loadSuggestConfig, editSuggestConfig } from '../../lib/suggest-config.mjs';
import { loadLocalConfig } from '../../cli/local-config.mjs';
import { UserError } from '../../lib/errors.mjs';
import { tempDir } from '../helpers.mjs';

const RETIRED = 'superpowers@superpowers-marketplace';
const put = (dir, value) => writeFile(path.join(dir, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
const rejects = (promise, pattern) => assert.rejects(promise, (e) => e instanceof UserError && pattern.test(e.message));

test('SUGGEST_DEFAULTS is the section 11 object', () => {
  assert.deepEqual(SUGGEST_DEFAULTS, {
    suggest: {
      enabled: false, hosted: false, url: null, maxSuggestions: 2,
      deadlineMs: { local: 1000, hosted: 3000 },
      rule: { maxRanks: null, minSimilarity: null, localMinGap: null, localMinGapEs: null },
      includeUnreviewed: true, retiredPlugins: [], disabledPaths: [],
    },
    enrich: { enabled: false, model: 'openai/gpt-5-mini' },
  });
});

test('a missing file gives the defaults, with the code-default retired plugin', async () => {
  const dir = await tempDir();
  const c = await loadSuggestConfig(dir);
  assert.deepEqual(c.enrich, SUGGEST_DEFAULTS.enrich);
  assert.deepEqual({ ...c.suggest, retiredPlugins: [] }, SUGGEST_DEFAULTS.suggest);
  assert.deepEqual(c.suggest.retiredPlugins, [RETIRED]);
});

test('a partial suggest section merges over the defaults and does not mutate them', async () => {
  const dir = await tempDir();
  await put(dir, { suggest: { enabled: true } });
  const c = await loadSuggestConfig(dir);
  assert.equal(c.suggest.enabled, true);
  assert.equal(c.suggest.maxSuggestions, 2);
  assert.deepEqual(c.suggest.deadlineMs, { local: 1000, hosted: 3000 });
  c.suggest.deadlineMs.local = 1;
  c.suggest.disabledPaths.push('x');
  assert.equal(SUGGEST_DEFAULTS.suggest.deadlineMs.local, 1000);
  assert.deepEqual(SUGGEST_DEFAULTS.suggest.disabledPaths, []);
});

test('deadlineMs is clamped to [200, 8000]', async () => {
  const dir = await tempDir();
  await put(dir, { suggest: { deadlineMs: { local: 50, hosted: 99999 } } });
  assert.deepEqual((await loadSuggestConfig(dir)).suggest.deadlineMs, { local: 200, hosted: 8000 });
});

test('a wrong type names the key in a UserError', async () => {
  const dir = await tempDir();
  const bad = [
    [{ suggest: { deadlineMs: { local: 'x' } } }, /suggest\.deadlineMs\.local/],
    [{ suggest: { enabled: 'yes' } }, /suggest\.enabled/],
    [{ suggest: { hosted: 1 } }, /suggest\.hosted/],
    [{ suggest: { url: 5 } }, /suggest\.url/],
    [{ suggest: { url: 'not a url' } }, /suggest\.url/],
    [{ suggest: { url: 'ftp://example.com' } }, /suggest\.url/],
    [{ suggest: { maxSuggestions: '2' } }, /suggest\.maxSuggestions/],
    [{ suggest: { maxSuggestions: 0 } }, /suggest\.maxSuggestions/],
    [{ suggest: { rule: { maxRanks: 'a' } } }, /suggest\.rule\.maxRanks/],
    [{ suggest: { rule: { minSimilarity: {} } } }, /suggest\.rule\.minSimilarity/],
    [{ suggest: { rule: { localMinGap: '1' } } }, /suggest\.rule\.localMinGap/],
    [{ suggest: { rule: { localMinGapEs: '1' } } }, /suggest\.rule\.localMinGapEs/],
    [{ suggest: { includeUnreviewed: null } }, /suggest\.includeUnreviewed/],
    [{ suggest: { retiredPlugins: 'a' } }, /suggest\.retiredPlugins/],
    [{ suggest: { disabledPaths: [1] } }, /suggest\.disabledPaths/],
    [{ suggest: [] }, /suggest/],
    [{ suggest: { deadlineMs: 5 } }, /suggest\.deadlineMs/],
    [{ enrich: { enabled: 'no' } }, /enrich\.enabled/],
    [{ enrich: { model: '' } }, /enrich\.model/],
    [{ enrich: 'x' }, /enrich/],
  ];
  for (const [value, pattern] of bad) {
    await put(dir, value);
    await rejects(loadSuggestConfig(dir), pattern);
  }
  await put(dir, '{not json');
  await rejects(loadSuggestConfig(dir), /config\.json/);
  await put(dir, '[]');
  await rejects(loadSuggestConfig(dir), /config\.json/);
});

test('rule values stay null when null, and numbers pass through', async () => {
  const dir = await tempDir();
  await put(dir, { suggest: { rule: { localMinGap: null, maxRanks: 3 } } });
  const { rule } = (await loadSuggestConfig(dir)).suggest;
  assert.deepEqual(rule, { maxRanks: 3, minSimilarity: null, localMinGap: null, localMinGapEs: null });
});

test('url accepts null and absolute http(s) URLs', async () => {
  const dir = await tempDir();
  await put(dir, { suggest: { url: 'https://headjack.example.com' } });
  assert.equal((await loadSuggestConfig(dir)).suggest.url, 'https://headjack.example.com');
  await put(dir, { suggest: { url: 'http://localhost:3000' } });
  assert.equal((await loadSuggestConfig(dir)).suggest.url, 'http://localhost:3000');
  await put(dir, { suggest: { url: null } });
  assert.equal((await loadSuggestConfig(dir)).suggest.url, null);
});

test('retiredPlugins always includes the code default, deduplicated', async () => {
  const dir = await tempDir();
  await put(dir, { suggest: { retiredPlugins: ['a@b', RETIRED, 'a@b'] } });
  assert.deepEqual((await loadSuggestConfig(dir)).suggest.retiredPlugins, [RETIRED, 'a@b']);
});

test('a malformed suggest section does not break loadLocalConfig (isolated validation)', async () => {
  const dir = await tempDir();
  await put(dir, { excludedRoots: ['/x'], suggest: { enabled: 'yes' }, enrich: 7 });
  assert.deepEqual(await loadLocalConfig(dir), { excludedRoots: ['/x'] });
  await rejects(loadSuggestConfig(dir), /suggest\.enabled/);
});

test('editSuggestConfig keeps every other top-level key and sub-key, and writes 0600 atomically', async () => {
  const dir = await tempDir();
  const original = { excludedRoots: ['/a', '~/b'], corePlugins: ['p@q'], other: { n: 1 }, suggest: { maxSuggestions: 5, deadlineMs: { hosted: 2000 } } };
  await put(dir, original);
  await editSuggestConfig(dir, { suggest: { enabled: true, deadlineMs: { local: 500 } } });
  const after = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(after.excludedRoots, original.excludedRoots);
  assert.deepEqual(after.corePlugins, original.corePlugins);
  assert.deepEqual(after.other, original.other);
  assert.deepEqual(after.suggest, { maxSuggestions: 5, deadlineMs: { hosted: 2000, local: 500 }, enabled: true });
  assert.equal((await stat(path.join(dir, 'config.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['config.json'], 'no temp file left behind');
  await editSuggestConfig(dir, { enrich: { enabled: true } });
  const c = await loadSuggestConfig(dir);
  assert.equal(c.enrich.enabled, true);
  assert.equal(c.suggest.enabled, true);
});

test('editSuggestConfig creates the file when missing, and an array in a patch replaces', async () => {
  const dir = await tempDir();
  await editSuggestConfig(dir, { suggest: { enabled: true, hosted: true } });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')), { suggest: { enabled: true, hosted: true } });
  await editSuggestConfig(dir, { suggest: { disabledPaths: ['/a'] } });
  await editSuggestConfig(dir, { suggest: { disabledPaths: ['/b'] } });
  assert.deepEqual((await loadSuggestConfig(dir)).suggest.disabledPaths, ['/b']);
});

test('editSuggestConfig refuses an invalid patch or an unparseable file and writes nothing', async () => {
  const dir = await tempDir();
  await put(dir, { suggest: { enabled: false } });
  const before = await readFile(path.join(dir, 'config.json'), 'utf8');
  await rejects(editSuggestConfig(dir, { suggest: { enabled: 'yes' } }), /suggest\.enabled/);
  assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), before);
  await put(dir, '{oops');
  await rejects(editSuggestConfig(dir, { suggest: { enabled: true } }), /config\.json/);
  assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), '{oops');
});
