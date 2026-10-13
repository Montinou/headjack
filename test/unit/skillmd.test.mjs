import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillMd, readSkillInfo, chunkSkill } from '../../lib/skillmd.mjs';
import { file } from '../helpers.mjs';

test('parses plain, quoted, folded and continued values', () => {
  const { meta, body } = parseSkillMd([
    '---',
    'name: "remotion-render"',
    'description: >',
    '  Export a Remotion',
    '  video to mp4.',
    'license: MIT',
    'tags: first line',
    '  continued here',
    '---',
    '# Body',
  ].join('\n'));
  assert.equal(meta.name, 'remotion-render');
  assert.equal(meta.description, 'Export a Remotion video to mp4.');
  assert.equal(meta.tags, 'first line continued here');
  assert.equal(body, '# Body');
});

test('no frontmatter returns whole text as body', () => {
  assert.deepEqual(parseSkillMd('# Title\ntext'), { meta: {}, body: '# Title\ntext' });
});

test('readSkillInfo falls back to folder name and first paragraph', () => {
  const info = readSkillInfo([file('SKILL.md', '# T\n\nDoes a thing.\nReally.\n\nMore.')], 'my-skill');
  assert.equal(info.name, 'my-skill');
  assert.equal(info.description, 'Does a thing. Really.');
});

test('readSkillInfo requires SKILL.md at the root', () => {
  assert.throws(() => readSkillInfo([file('sub/SKILL.md', 'x')], 'x'), /SKILL.md not found/);
});

test('chunkSkill indexes headings with first paragraph, skipping code fences', () => {
  const body = ['# Usage', '', 'Run the render.', 'Twice.', '', '```', '# not a heading', '```', '## Captions', 'Add captions.'].join('\n');
  assert.deepEqual(chunkSkill({ name: 'r', description: 'Render videos', body }), [
    'r: Render videos',
    'r — Usage: Run the render. Twice.',
    'r — Captions: Add captions.',
  ]);
});

test('chunkSkill caps count and length', () => {
  const body = Array.from({ length: 60 }, (_, i) => `# H${i}\n${'z'.repeat(2000)}`).join('\n');
  const chunks = chunkSkill({ name: 'n', description: 'd', body });
  assert.equal(chunks.length, 40);
  assert.ok(chunks.every((c) => c.length <= 1000));
});
