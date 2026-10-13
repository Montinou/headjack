import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = new URL('../../skill-finder/SKILL.md', import.meta.url);
const DESCRIPTION = "description: Use when a task needs a capability, tool integration, or domain workflow you don't have loaded — search the personal skill vault before improvising or installing anything from the internet.";

test('skill-finder keeps its triggers and walks the session-scoped flow', async () => {
  const md = await readFile(SRC, 'utf8');
  assert.ok(md.startsWith('---\nname: skill-finder\n'), 'frontmatter');
  assert.ok(md.includes(`\n${DESCRIPTION}\n`), 'description triggers unchanged');
  assert.ok(md.trimEnd().split('\n').length <= 40, 'short');
  for (const needle of [
    'headjack search "<need in English>" --json',
    '--tag',
    'top 3',
    'headjack add <slug> --to <your-harness-id> --session',
    'Claude Code → claude', 'Codex → codex', 'Grok → grok', 'Gemini CLI → gemini', 'Cursor → cursor',
    'headjack harness detect',
    '/reload-plugins',
    'restart',
    'headjack remove <slug> --from <your-harness-id>',
    'headjack review',
  ]) assert.ok(md.includes(needle), needle);
  assert.match(md, /ask the user before install/i);
  assert.match(md, /cannot run slash commands/i);
  assert.match(md, /never install .*github or a marketplace/i);
});
