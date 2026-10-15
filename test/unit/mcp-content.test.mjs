import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pack, unpack, buildHeader } from '../../lib/tar.mjs';
const file = (path, text) => ({ path, mode: 0o644, data: Buffer.from(text) });
const standalone = { kind: 'skill', plugin_slug: null };
const unavailable = { skill_md: null, truncated: false, content_status: 'unavailable' };
const load = () => import('../../lib/mcp/content.mjs');

test('reads only exact root stored SKILL.md including frontmatter', async () => {
  const { readSkillContent } = await load();
  const text = '---\nname: stored\n---\n# Exact original\n';
  assert.deepEqual(readSkillContent(standalone, pack([file('SKILL.md', text), file('nested/SKILL.md', 'private')])), { skill_md: text, truncated: false, content_status: 'available' });
});

test('plugin, plugin_slug, null archive and missing root have unavailable body', async () => {
  const { readSkillContent } = await load();
  for (const row of [{ kind: 'plugin' }, { kind: 'skill', plugin_slug: '' }, { kind: 'skill', plugin_slug: 'plugin@market' }]) {
    assert.deepEqual(readSkillContent(row, Buffer.from('bad archive')), unavailable);
  }
  assert.deepEqual(readSkillContent(standalone, null), unavailable);
  assert.deepEqual(readSkillContent(standalone, pack([file('nested/SKILL.md', 'x')])), unavailable);
});

test('8192 UTF-8 byte limit keeps complete two, three and four-byte codepoints', async () => {
  const { readSkillContent } = await load();
  for (const [prefix, suffix, expected] of [['a'.repeat(8191), 'é', 'a'.repeat(8191)], ['a'.repeat(8190), '€', 'a'.repeat(8190)], ['a'.repeat(8189), '😀', 'a'.repeat(8189)]]) {
    const body = readSkillContent(standalone, pack([file('SKILL.md', prefix + suffix)]));
    assert.equal(Buffer.byteLength(body.skill_md) <= 8192, true);
    assert.equal(body.skill_md, expected);
    assert.equal(body.truncated, true);
  }
  assert.equal(readSkillContent(standalone, pack([file('SKILL.md', '😀'.repeat(2048))])).truncated, false);
});

test('validates every archive entry before returning root content', async () => {
  const { readSkillContent } = await load();
  const root = gunzipSync(pack([file('SKILL.md', 'safe')]));
  const unsafe = gzipSync(Buffer.concat([root.subarray(0, 1024), buildHeader('../private', 0o644, 0), Buffer.alloc(1024)]));
  const corrupt = Buffer.from(root); corrupt[1024] = 1;
  for (const archive of [unsafe, gzipSync(corrupt), Buffer.from('private provider error'), pack([file('SKILL.md', 'x'), file('link', 'x')]).subarray(0, 30), Buffer.alloc(16 * 1024 * 1024 + 1)]) {
    assert.throws(() => readSkillContent(standalone, archive), { code: 'content_unavailable' });
  }
});

test('bounded unpack rejects >16 MiB expansion in zlib before parsing while default remains compatible', () => {
  const archive = pack([file('SKILL.md', 'x'.repeat(16 * 1024 * 1024))]);
  assert.throws(() => unpack(archive, { maxOutputLength: 16 * 1024 * 1024 }), { code: 'ERR_BUFFER_TOO_LARGE' });
  assert.equal(unpack(archive)[0].data.length, 16 * 1024 * 1024);
});

test('oversized expansion yields stable content_unavailable without a body', async () => {
  const { readSkillContent } = await load();
  assert.throws(() => readSkillContent(standalone, pack([file('SKILL.md', 'x'.repeat(16 * 1024 * 1024))])), { code: 'content_unavailable' });
});

test('preserves the UTF-8 BOM in the exact stored root text', async () => {
  const { readSkillContent } = await load();
  const text = '\ufeff# Stored BOM\n';
  assert.equal(readSkillContent(standalone, pack([file('SKILL.md', text)])).skill_md, text);
});
