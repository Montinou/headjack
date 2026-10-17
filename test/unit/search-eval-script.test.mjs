// Unit tests of scripts/search-eval.mjs with invented fixtures. The owner's eval set and the assertions about its catalog
// live in the private-only search-eval-catalog.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, armHeaders, OVERRIDE_COOKIE, expectArg, fileArg, passes } from '../../scripts/search-eval.mjs';
import { captureLog } from '../helpers.mjs';

const USAGE = 'usage: npm run search-eval -- --file <eval.json>';

test('fileArg returns the --file path and requires it', () => {
  assert.equal(fileArg(['--file', 'eval/pairs.json']), 'eval/pairs.json');
  assert.equal(fileArg(['--arm', 'control', '--file', 'x.json', '--expect', 'rrf-english']), 'x.json');
  assert.throws(() => fileArg([]), { code: 'usage', message: USAGE });
  assert.throws(() => fileArg(['--arm', 'control']), { code: 'usage', message: USAGE });
  assert.throws(() => fileArg(['--file']), { code: 'usage', message: USAGE });
  assert.throws(() => fileArg(['--file', '--expect', 'rrf-english']), { code: 'usage', message: USAGE });
});

test('the script without --file exits 2 with the usage line and reads no default eval set', () => {
  const script = fileURLToPath(new URL('../../scripts/search-eval.mjs', import.meta.url));
  const { status, stderr } = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent-home' } });
  assert.equal(status, 2);
  assert.equal(stderr.trim(), USAGE);
});

test('evaluate reports top-3 and top-1 accuracy per language and searches with purpose eval', async () => {
  const calls = [];
  const api = {
    async getSkill(slug) { return { slug }; },
    async search(q, k, kind, tags, purpose) {
      calls.push({ q, k, kind, tags, purpose });
      return { a: [{ slug: 'x' }, { slug: 'y' }, { slug: 'z' }], b: [{ slug: 'b1' }, { slug: 'y' }], c: [{ slug: 'q' }], d: [{ slug: 'd1' }] }[q];
    },
  };
  const log = captureLog();
  const out = await evaluate([
    { q: 'a', slug: 'x', lang: 'en' },
    { q: 'b', slug: 'y', lang: 'en' },
    { q: 'c', slug: 'nope', lang: 'en' },
    { q: 'd', slug: 'd1', lang: 'es' },
  ], api, log);
  assert.deepEqual(out, { byLang: { en: { evaluated: 3, top3: 2, top1: 1 }, es: { evaluated: 1, top3: 1, top1: 1 } } });
  assert.match(log.text(), /en: 2\/3 in top 3 \(67%\) · top 1 1\/3/);
  assert.match(log.text(), /es: 1\/1 in top 3 \(100%\) · top 1 1\/1/);
  assert.match(log.text(), /MISS {2}nope/);
  assert.deepEqual(calls.map((c) => [c.k, c.kind, c.tags, c.purpose]), Array(4).fill([3, undefined, [], 'eval']));
});

test('evaluate reports zero rows for a language with no pairs', async () => {
  const api = { async getSkill(slug) { return { slug }; }, async search() { return [{ slug: 'x' }]; } };
  const out = await evaluate([{ q: 'a', slug: 'x', lang: 'en' }], api, captureLog());
  assert.deepEqual(out.byLang.es, { evaluated: 0, top3: 0, top1: 0 });
});

test('evaluate throws naming the first slug missing from the vault', async () => {
  const searched = [];
  const api = {
    async getSkill(slug) { return slug === 'gone' ? null : { slug }; },
    async search(q) { searched.push(q); return [{ slug: 'x' }]; },
  };
  await assert.rejects(
    evaluate([{ q: 'a', slug: 'x', lang: 'en' }, { q: 'd', slug: 'gone', lang: 'es' }, { q: 'e', slug: 'gone2', lang: 'en' }], api, captureLog()),
    { message: 'slug missing from the vault: gone' },
  );
  assert.ok(!searched.includes('d'), 'the missing slug is not searched');
});

test('passes needs 10 evaluated rows per language and English top-3 of at least 90%', () => {
  const lang = (evaluated, top3) => ({ evaluated, top3, top1: 0 });
  assert.equal(passes({ en: lang(10, 9), es: lang(10, 0) }), true);
  assert.equal(passes({ en: lang(10, 8), es: lang(10, 10) }), false);
  assert.equal(passes({ en: lang(9, 9), es: lang(10, 10) }), false);
  assert.equal(passes({ en: lang(20, 20), es: lang(9, 9) }), false);
});

test('armHeaders pins the chosen arm as a cookie header and leaves the input env alone', () => {
  const env = { HOME: '/h', HEADJACK_OVERRIDE_CONTROL: 'ctl-value', HEADJACK_OVERRIDE_BILINGUAL: 'bi-value' };
  const copy = { ...env };
  assert.deepEqual(armHeaders([], env), { arm: 'default', headers: {} });
  assert.deepEqual(armHeaders(['--arm', 'control'], env), { arm: 'control', headers: { cookie: `${OVERRIDE_COOKIE}=ctl-value` } });
  assert.deepEqual(armHeaders(['--arm', 'bilingual'], env), { arm: 'bilingual', headers: { cookie: `${OVERRIDE_COOKIE}=bi-value` } });
  assert.deepEqual(env, copy);
});

test('armHeaders rejects an unknown arm and a missing override, naming the variable but never a value', () => {
  assert.throws(() => armHeaders(['--arm', 'other'], {}), { code: 'usage', message: 'usage: npm run search-eval -- --file <eval.json> [--arm control|bilingual]' });
  assert.throws(() => armHeaders(['--arm'], {}), { code: 'usage' });
  const env = { HEADJACK_OVERRIDE_CONTROL: 'secret-ctl' };
  assert.throws(() => armHeaders(['--arm', 'bilingual'], env), (e) => e.code === 'usage' && /HEADJACK_OVERRIDE_BILINGUAL/.test(e.message) && !/secret/.test(e.message));
});

// Runs the script against a stub server; resolves with what the server saw.
async function runScript(t, args, extraEnv) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: new URL(req.url, 'http://x').pathname, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/api/search') ? { results: [{ slug: 'x', variant: 'rrf-english' }] } : { skill: { slug: 'x' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sv-search-eval-'));
  t.after(async () => { await new Promise((r) => { server.closeAllConnections(); server.close(r); }); await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'eval.json');
  await writeFile(file, JSON.stringify([{ q: 'a', slug: 'x', lang: 'en' }]));
  const script = fileURLToPath(new URL('../../scripts/search-eval.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, HOME: dir, HEADJACK_URL: `http://127.0.0.1:${server.address().port}`, HEADJACK_TOKEN: 'key', ...extraEnv };
  const child = spawn(process.execPath, [script, '--file', file, ...args], { env, stdio: 'ignore' });
  await new Promise((resolve) => child.on('close', resolve));
  return seen;
}

const OLD_ENV = { VERCEL_AUTOMATION_BYPASS_SECRET: 'sekret-value', HEADJACK_FLAG_OVERRIDES: 'sekret-value' };

test('search-eval --arm still sends the pinned arm cookie, and nothing the old variables hold', async (t) => {
  const seen = await runScript(t, ['--arm', 'control'], { ...OLD_ENV, HEADJACK_OVERRIDE_CONTROL: 'ctl-value' });
  assert.deepEqual(seen.map((r) => r.path), ['/api/skills/x', '/api/search']);
  for (const r of seen) {
    assert.equal(r.headers.cookie, `${OVERRIDE_COOKIE}=ctl-value`);
    assert.equal(r.headers.authorization, 'Bearer key');
    assert.deepEqual(Object.keys(r.headers).filter((h) => /bypass/i.test(h)), []);
    assert.ok(!JSON.stringify(r.headers).includes('sekret-value'));
  }
});

test('search-eval without --arm sends no cookie, whatever the old variables hold', async (t) => {
  const seen = await runScript(t, [], OLD_ENV);
  assert.equal(seen.length, 2);
  for (const r of seen) {
    assert.ok(!('cookie' in r.headers));
    assert.ok(!JSON.stringify(r.headers).includes('sekret-value'));
  }
});

// --- variant checks: each row names the variant that answered; --expect pins it; one run never mixes variants ---

const variantApi = (byQ) => ({
  async getSkill(slug) { return { slug }; },
  async search(q) { return byQ[q]; },
});

test('evaluate prints the variant that answered on each row line', async () => {
  const api = variantApi({ a: [{ slug: 'x', variant: 'rrf-english' }, { slug: 'y', variant: 'rrf-english' }], b: [] });
  const log = captureLog();
  await evaluate([{ q: 'a', slug: 'x', lang: 'en' }, { q: 'b', slug: 'z', lang: 'es' }], api, log);
  assert.match(log.text(), /ok1 +x .*variant=rrf-english/);
  assert.match(log.text(), /MISS {2}z .*variant=-/, 'a row with no results names no variant');
});

test('evaluate with expect passes when every result carries the expected variant', async () => {
  const api = variantApi({ a: [{ slug: 'x', variant: 'rrf-bilingual' }], b: [{ slug: 'y', variant: 'rrf-bilingual' }] });
  const out = await evaluate([{ q: 'a', slug: 'x', lang: 'en' }, { q: 'b', slug: 'y', lang: 'es' }], api, captureLog(), { expect: 'rrf-bilingual' });
  assert.equal(out.byLang.en.top1, 1);
});

test('evaluate with expect throws naming the first row answered by another variant', async () => {
  const api = variantApi({
    a: [{ slug: 'x', variant: 'rrf-bilingual' }],
    b: [{ slug: 'y', variant: 'rrf-english' }],
    c: [{ slug: 'z', variant: 'rrf-english' }],
  });
  await assert.rejects(
    evaluate([{ q: 'a', slug: 'x', lang: 'en' }, { q: 'b', slug: 'y', lang: 'en' }, { q: 'c', slug: 'z', lang: 'en' }], api, captureLog(), { expect: 'rrf-bilingual' }),
    (e) => /rrf-english/.test(e.message) && /rrf-bilingual/.test(e.message) && /"b"/.test(e.message) && !/"c"/.test(e.message),
  );
  const unnamed = variantApi({ a: [{ slug: 'x' }] });
  await assert.rejects(evaluate([{ q: 'a', slug: 'x', lang: 'en' }], unnamed, captureLog(), { expect: 'rrf-english' }), /\(none\) instead of rrf-english/);
});

test('evaluate throws when one run sees mixed variants, with or without expect', async () => {
  const api = variantApi({ a: [{ slug: 'x', variant: 'rrf-english' }], b: [{ slug: 'y', variant: 'rrf-bilingual' }] });
  await assert.rejects(
    evaluate([{ q: 'a', slug: 'x', lang: 'en' }, { q: 'b', slug: 'y', lang: 'es' }], api, captureLog()),
    (e) => /mixed variants/.test(e.message) && /"b"/.test(e.message),
  );
  const within = variantApi({ a: [{ slug: 'x', variant: 'rrf-english' }, { slug: 'y', variant: 'rrf-bilingual' }] });
  await assert.rejects(evaluate([{ q: 'a', slug: 'x', lang: 'en' }], within, captureLog()), /mixed variants/);
});

test('expectArg reads --expect rrf-english|rrf-bilingual and rejects anything else', () => {
  assert.equal(expectArg([]), undefined);
  assert.equal(expectArg(['--expect', 'rrf-english']), 'rrf-english');
  assert.equal(expectArg(['--arm', 'control', '--expect', 'rrf-bilingual']), 'rrf-bilingual');
  assert.throws(() => expectArg(['--expect', 'bilingual']), { code: 'usage', message: 'usage: npm run search-eval -- --file <eval.json> [--expect rrf-english|rrf-bilingual]' });
  assert.throws(() => expectArg(['--expect']), { code: 'usage' });
});

test('evaluate skips rows with slug: null, prints the count and evaluates the rest', async () => {
  const searched = [];
  const looked = [];
  const api = {
    async getSkill(slug) { looked.push(slug); return { slug }; },
    async search(q) { searched.push(q); return [{ slug: 'x' }]; },
  };
  const log = captureLog();
  const out = await evaluate([
    { q: 'a', slug: 'x', lang: 'en' },
    { q: 'nothing fits this', slug: null, lang: 'en' },
    { q: 'd', slug: 'x', lang: 'es' },
  ], api, log);
  assert.deepEqual(out, { byLang: { en: { evaluated: 1, top3: 1, top1: 1 }, es: { evaluated: 1, top3: 1, top1: 1 } } });
  assert.deepEqual(searched, ['a', 'd']);
  assert.deepEqual(looked, ['x', 'x']);
  assert.match(log.text(), /skipped 1 row with slug: null/);
  assert.doesNotMatch(log.text(), /nothing fits this/);
});

test('evaluate counts several skipped null rows in the plural and prints nothing when there are none', async () => {
  const api = { async getSkill(slug) { return { slug }; }, async search() { return [{ slug: 'x' }]; } };
  const some = captureLog();
  await evaluate([{ q: 'a', slug: 'x', lang: 'en' }, { q: 'b', slug: null, lang: 'en' }, { q: 'c', slug: null, lang: 'es' }], api, some);
  assert.match(some.text(), /skipped 2 rows with slug: null/);
  const none = captureLog();
  await evaluate([{ q: 'a', slug: 'x', lang: 'en' }], api, none);
  assert.doesNotMatch(none.text(), /skipped/);
});
