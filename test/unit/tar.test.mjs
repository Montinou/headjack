import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { pack, unpack, writeFiles, buildHeader } from '../../lib/tar.mjs';
import { hashFiles, hashDir } from '../../lib/hash.mjs';
import { file, tempDir } from '../helpers.mjs';

const rawTar = (...blocks) => gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));

test('round-trips paths, modes and content', () => {
  const files = [file('SKILL.md', '# hi'), file('scripts/run.sh', '#!/bin/sh\necho', 0o755), file('empty.txt', '')];
  const out = unpack(pack(files));
  assert.equal(hashFiles(out), hashFiles(files));
  assert.deepEqual(out.map((f) => f.path), ['SKILL.md', 'empty.txt', 'scripts/run.sh']);
});

test('round-trips long and unicode paths', () => {
  const deep = `${'references/'.repeat(10)}guía-ñandú-${'x'.repeat(60)}.md`;
  assert.ok(Buffer.byteLength(deep) > 100);
  const files = [file(deep, 'contenido'), file('SKILL.md', 'x')];
  assert.equal(hashFiles(unpack(pack(files))), hashFiles(files));
});

test('rejects a path that cannot fit ustar', () => {
  assert.throws(() => pack([file('a'.repeat(120), 'x')]), /path too long/);
});

test('rejects path traversal and absolute paths', () => {
  for (const bad of ['../evil', 'a/../../evil', '/etc/passwd']) {
    const data = Buffer.from('x');
    const tgz = rawTar(buildHeader(bad, 0o644, 1), Buffer.concat([data, Buffer.alloc(511)]));
    assert.throws(() => unpack(tgz), /unsafe path/, bad);
  }
});

test('rejects symlink and directory entries', () => {
  assert.throws(() => unpack(rawTar(buildHeader('link', 0o644, 0, '2'))), /unsupported tar entry/);
  assert.throws(() => unpack(rawTar(buildHeader('dir', 0o755, 0, '5'))), /unsupported tar entry/);
});

test('rejects a corrupted header', () => {
  const h = buildHeader('a.md', 0o644, 0);
  h[0] = 'b'.charCodeAt(0);
  assert.throws(() => unpack(rawTar(h)), /checksum/);
});

const rawBody = (...files) => gunzipSync(pack(files));
const withChecksum = (h) => {
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
};

test('rejects a tar cut at an entry boundary (missing end-of-archive)', () => {
  const body = rawBody(file('a.md', 'x'), file('b.md', 'y'));
  assert.throws(() => unpack(gzipSync(body.subarray(0, 1024))), /missing end-of-archive/);
  assert.throws(() => unpack(gzipSync(body.subarray(0, body.length - 512))), /missing end-of-archive/);
  assert.deepEqual(unpack(pack([])), []);
});

test('rejects a tar cut in the middle of an entry', () => {
  const body = rawBody(file('a.md', 'z'.repeat(600)));
  assert.throws(() => unpack(gzipSync(body.subarray(0, 512 + 100))), /truncated tar entry/);
});

test('rejects non-octal size and mode fields even with a valid checksum', () => {
  const badSize = buildHeader('a.md', 0o644, 1);
  badSize.write('zzzzzzzzzzz\0', 124, 12, 'ascii');
  assert.throws(() => unpack(rawTar(withChecksum(badSize), Buffer.alloc(512))), /invalid tar size/);
  const badMode = buildHeader('a.md', 0o644, 0);
  badMode.write('-000644\0', 100, 8, 'ascii');
  assert.throws(() => unpack(rawTar(withChecksum(badMode))), /invalid tar mode/);
});

test('rejects duplicate paths', () => {
  const entry = (c) => [buildHeader('a.md', 0o644, 1), Buffer.concat([Buffer.from(c), Buffer.alloc(511)])];
  assert.throws(() => unpack(rawTar(...entry('x'), ...entry('y'))), /duplicate path/);
});

test('writeFiles materializes a tree with the same hash', async () => {
  const files = [file('SKILL.md', 'x'), file('bin/tool', 'y', 0o755)];
  const root = path.join(await tempDir(), 'skill');
  await writeFiles(root, files);
  assert.equal(await hashDir(root), hashFiles(files));
});
