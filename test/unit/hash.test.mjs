import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { listFiles, hashFiles, hashDir } from '../../lib/hash.mjs';
import { makeDir, file } from '../helpers.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

test('pins the line format', () => {
  const expected = sha(`a.md\x000644\x00${sha('x')}\n`);
  assert.equal(hashFiles([file('a.md', 'x')]), expected);
});

test('is independent of creation order', async () => {
  const a = await makeDir({ 'SKILL.md': 'x', 'ref/b.md': 'y' });
  const b = await makeDir({ 'ref/b.md': 'y', 'SKILL.md': 'x' });
  assert.equal(await hashDir(a), await hashDir(b));
});

test('changes with content, path and exec bit', async () => {
  const base = await hashDir(await makeDir({ 'SKILL.md': 'x' }));
  assert.notEqual(base, await hashDir(await makeDir({ 'SKILL.md': 'y' })));
  assert.notEqual(base, await hashDir(await makeDir({ 'OTHER.md': 'x' })));
  assert.notEqual(base, await hashDir(await makeDir({ 'SKILL.md': { content: 'x', mode: 0o755 } })));
});

test('ignores .git and .DS_Store', async () => {
  const a = await makeDir({ 'SKILL.md': 'x' });
  const b = await makeDir({ 'SKILL.md': 'x', '.DS_Store': 'junk', '.git/HEAD': 'ref' });
  assert.equal(await hashDir(a), await hashDir(b));
});

test('lists files sorted with normalized modes', async () => {
  const root = await makeDir({ 'b.sh': { content: '#!/bin/sh', mode: 0o700 }, 'a.md': 'x' });
  const files = await listFiles(root);
  assert.deepEqual(files.map((f) => [f.path, f.mode]), [['a.md', 0o644], ['b.sh', 0o755]]);
});

test('rejects symlinks', async () => {
  const root = await makeDir({ 'SKILL.md': 'x' });
  await symlink('/etc/hosts', path.join(root, 'link'));
  await assert.rejects(listFiles(root), /symlink not allowed: link/);
});
