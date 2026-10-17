import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, readdir, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../helpers.mjs';
import { logFile, casesFile, appendEvent, appendCase, readEvents } from '../../lib/suggest-log.mjs';

const tmp = () => tempDir('hj-suggest-log-');
const mode = async (p) => (await stat(p)).mode & 0o777;

test('logFile is <dir>/suggest/log.jsonl', () => {
  assert.equal(logFile('/x/.headjack'), path.join('/x/.headjack', 'suggest', 'log.jsonl'));
});

test('appendEvent creates the directory 0700 and the file 0600, one JSON line per event', async () => {
  const dir = await tmp();
  await appendEvent(dir, { type: 'add', session: 's1', at: '2026-10-17T10:00:00.000Z', slug: 'a', source: 'x' });
  await appendEvent(dir, { type: 'invoke', session: 's1', at: '2026-10-17T10:01:00.000Z', skill: 'a', slug: null });
  assert.equal(await mode(path.join(dir, 'suggest')), 0o700);
  assert.equal(await mode(logFile(dir)), 0o600);
  const lines = (await readFile(logFile(dir), 'utf8')).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.deepEqual(JSON.parse(lines[1]), { type: 'invoke', session: 's1', at: '2026-10-17T10:01:00.000Z', skill: 'a', slug: null });
});

test('appendEvent rotates to log.1.jsonl past maxBytes and keeps one previous file', async () => {
  const dir = await tmp();
  const ev = (n) => ({ type: 'add', session: 's', at: '2026-10-17T10:00:00.000Z', slug: `slug-${n}`, source: 'x' });
  const size = Buffer.byteLength(JSON.stringify(ev(0)) + '\n');
  const maxBytes = size * 2; // two events fit; the third finds the file at the limit, the fourth over it
  for (let n = 0; n < 3; n += 1) await appendEvent(dir, ev(n), { maxBytes });
  assert.deepEqual((await readdir(path.join(dir, 'suggest'))).sort(), ['log.jsonl']);
  await appendEvent(dir, ev(3), { maxBytes });
  assert.deepEqual((await readdir(path.join(dir, 'suggest'))).sort(), ['log.1.jsonl', 'log.jsonl']);
  assert.equal(await mode(path.join(dir, 'suggest', 'log.1.jsonl')), 0o600);
  assert.deepEqual((await readEvents(dir)).map((e) => e.slug), ['slug-0', 'slug-1', 'slug-2', 'slug-3']);
  // keep going: a second rotation replaces log.1.jsonl, the oldest events are gone
  for (let n = 4; n < 9; n += 1) await appendEvent(dir, ev(n), { maxBytes });
  const slugs = (await readEvents(dir)).map((e) => e.slug);
  assert.equal(slugs.at(-1), 'slug-8');
  assert.ok(!slugs.includes('slug-0'));
  assert.deepEqual(slugs, [...slugs].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))));
  assert.deepEqual((await readdir(path.join(dir, 'suggest'))).sort(), ['log.1.jsonl', 'log.jsonl']);
});

test('default rotation threshold is 5 MiB', async () => {
  const dir = await tmp();
  await appendEvent(dir, { type: 'add', n: 1 });
  await appendFile(logFile(dir), Buffer.alloc(5 * 1024 * 1024 - (await stat(logFile(dir))).size));
  assert.equal((await stat(logFile(dir))).size, 5 * 1024 * 1024);
  await appendEvent(dir, { type: 'add', n: 2 }); // exactly at the limit: not rotated
  assert.deepEqual((await readdir(path.join(dir, 'suggest'))).sort(), ['log.jsonl']);
  await appendEvent(dir, { type: 'add', n: 3 }); // over the limit: rotated
  assert.deepEqual((await readdir(path.join(dir, 'suggest'))).sort(), ['log.1.jsonl', 'log.jsonl']);
});

test('readEvents filters by since, oldest first across both files', async () => {
  const dir = await tmp();
  const at = (m) => new Date(Date.UTC(2026, 9, 17, 10, m)).toISOString();
  await appendEvent(dir, { type: 'add', slug: 'old', at: at(0) });
  await appendEvent(dir, { type: 'add', slug: 'mid', at: at(30) });
  await appendEvent(dir, { type: 'add', slug: 'new', at: at(59) });
  const since = new Date(Date.UTC(2026, 9, 17, 10, 30));
  assert.deepEqual((await readEvents(dir, { since })).map((e) => e.slug), ['mid', 'new']);
  assert.deepEqual((await readEvents(dir)).map((e) => e.slug), ['old', 'mid', 'new']);
});

test('readEvents skips malformed and non-object lines and tolerates a missing log', async () => {
  const dir = await tmp();
  assert.deepEqual(await readEvents(dir), []);
  await appendEvent(dir, { type: 'add', slug: 'a' });
  await appendFile(logFile(dir), '{not json\n\n[1,2]\n"str"\nnull\n{"type":"add","slug":"b"}\n{"type":"add","slug":"trunc');
  assert.deepEqual((await readEvents(dir)).map((e) => e.slug), ['a', 'b']);
});

test('appendEvent into an unwritable location resolves without throwing', async () => {
  const dir = await tmp();
  const blocker = path.join(dir, 'file');
  await writeFile(blocker, 'x');
  await assert.doesNotReject(appendEvent(path.join(blocker, 'nested'), { type: 'add' }));
  await assert.doesNotReject(appendEvent(dir, undefined));
  await assert.doesNotReject(appendEvent(dir, 'not an object'));
  await assert.doesNotReject(appendEvent(dir, { big: 1n })); // JSON.stringify throws
  assert.deepEqual(await readEvents(dir), []);
});

// ---- appendCase: the only file that holds prompt text (spec §5.4) ----

test('appendCase writes { q, slug, lang, at } to <dir>/suggest/cases.jsonl, file 0600, directory 0700, one line per case', async () => {
  const dir = await tmp();
  await appendCase(dir, { q: 'agregar flags', slug: null, lang: 'es', at: '2026-10-17T10:00:00.000Z' });
  await appendCase(dir, { q: 'two\nlines', slug: 'zq-helper', lang: 'en', at: '2026-10-17T10:01:00.000Z' });
  assert.equal(casesFile(dir), path.join(dir, 'suggest', 'cases.jsonl'));
  assert.equal(await mode(path.join(dir, 'suggest')), 0o700);
  assert.equal(await mode(casesFile(dir)), 0o600);
  const lines = (await readFile(casesFile(dir), 'utf8')).split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { q: 'agregar flags', slug: null, lang: 'es', at: '2026-10-17T10:00:00.000Z' });
  assert.equal(JSON.parse(lines[1]).q, 'two\nlines');
});

test('appendCase tightens a loose existing directory and file, and does not touch the event log', async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, 'suggest'), { mode: 0o755 });
  await writeFile(path.join(dir, 'suggest', 'cases.jsonl'), '', { mode: 0o644 });
  await appendCase(dir, { q: 'x', slug: null, lang: 'en', at: '2026-10-17T10:00:00.000Z' });
  assert.equal(await mode(path.join(dir, 'suggest')), 0o700);
  assert.equal(await mode(casesFile(dir)), 0o600);
  assert.deepEqual(await readdir(path.join(dir, 'suggest')), ['cases.jsonl']);
});

test('appendCase reports a failure instead of hiding it (a saved case that was not saved must be noticed)', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'suggest'), 'a file where the directory should be');
  await assert.rejects(appendCase(dir, { q: 'x', slug: null, lang: 'en', at: '2026-10-17T10:00:00.000Z' }));
});
