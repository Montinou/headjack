// The plugin packaging of the client: manifest, launcher and the skills directory it points at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));

test('the plugin is named headjack and its version is x.y.z', () => {
  assert.equal(manifest.name, 'headjack');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('cli/headjack exists and is executable', () => {
  const launcher = path.join(ROOT, 'cli/headjack');
  assert.ok(statSync(launcher).isFile(), 'cli/headjack is a file');
  accessSync(launcher, constants.X_OK);
});

test('every skills path of the manifest exists and holds SKILL.md', () => {
  assert.ok(Array.isArray(manifest.skills) && manifest.skills.length > 0);
  for (const rel of manifest.skills) {
    const dir = path.join(ROOT, rel);
    assert.ok(statSync(dir).isDirectory(), `${rel} is a directory`);
    assert.ok(existsSync(path.join(dir, 'SKILL.md')), `${rel} holds SKILL.md`);
  }
});

test('the plugin declares the headjack MCP server inline, at a semver version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.mcpServers, { headjack: { command: '${CLAUDE_PLUGIN_ROOT}/cli/headjack', args: ['mcp'] } });
  // A .mcp.json at the root would be read as project configuration in any checkout of the repository.
  assert.equal(existsSync(path.join(ROOT, '.mcp.json')), false);
});

test('the plugin registers the prompt, warm-up and skill-used hooks from an existing file, through the lean entry', () => {
  assert.equal(manifest.hooks, './plugin-hooks/hooks.json');
  const file = path.join(ROOT, manifest.hooks);
  assert.ok(statSync(file).isFile(), 'the hooks file exists');
  const { hooks } = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
  const entry = (name) => `node "\${CLAUDE_PLUGIN_ROOT}/cli/hook-entry.mjs" ${name}`;
  assert.deepEqual(hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: entry('prompt'), timeout: 10 }] }]);
  assert.deepEqual(hooks.SessionStart, [{ hooks: [{ type: 'command', command: entry('warmup'), timeout: 15, async: true }] }]);
  assert.deepEqual(hooks.PostToolUse, [{ matcher: 'Skill', hooks: [{ type: 'command', command: entry('skill-used'), timeout: 5 }] }]);
  assert.ok(statSync(path.join(ROOT, 'cli/hook-entry.mjs')).isFile(), 'the entry the hooks run exists');
});
