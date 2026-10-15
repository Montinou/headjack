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

test('bin/headjack exists and is executable', () => {
  const launcher = path.join(ROOT, 'bin/headjack');
  assert.ok(statSync(launcher).isFile(), 'bin/headjack is a file');
  accessSync(launcher, constants.X_OK);
});

test('the skills path of the manifest exists and holds SKILL.md', () => {
  assert.equal(typeof manifest.skills, 'string');
  const dir = path.join(ROOT, manifest.skills);
  assert.ok(statSync(dir).isDirectory(), `${manifest.skills} is a directory`);
  assert.ok(existsSync(path.join(dir, 'SKILL.md')), 'the skills directory holds SKILL.md');
});

test('the plugin declares the headjack MCP server inline, at a semver version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.mcpServers, { headjack: { command: '${CLAUDE_PLUGIN_ROOT}/bin/headjack', args: ['mcp'] } });
  // A .mcp.json at the root would be read as project configuration in any checkout of the repository.
  assert.equal(existsSync(path.join(ROOT, '.mcp.json')), false);
});
