import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findSkillDirs } from '../../lib/find.mjs';
import { makeDir } from '../helpers.mjs';

test('finds skill dirs, skipping node_modules/.git and nested skills', async () => {
  const root = await makeDir({
    'skills/a/SKILL.md': 'a',
    'skills/a/inner/SKILL.md': 'nested',
    'skills/b/SKILL.md': 'b',
    'node_modules/x/SKILL.md': 'no',
    '.git/y/SKILL.md': 'no',
  });
  assert.deepEqual(await findSkillDirs(root), [path.join(root, 'skills/a'), path.join(root, 'skills/b')]);
});

test('root itself can be the skill', async () => {
  const root = await makeDir({ 'SKILL.md': 'x' });
  assert.deepEqual(await findSkillDirs(root), [root]);
});
