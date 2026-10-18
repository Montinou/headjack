// writing-skills/SKILL.md (shipped in the plugin, never through the vault) teaches agents to write vault skills that
// skill-finder finds. These checks pin what the agent evaluation showed it needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const md = await readFile(path.join(ROOT, 'writing-skills/SKILL.md'), 'utf8');

test('writing-skills has a short "Use when" description with no order in it', () => {
  assert.ok(md.startsWith('---\nname: writing-skills\ndescription: Use when '), 'frontmatter');
  const description = md.split('\n')[2].slice('description: '.length);
  assert.ok(description.length <= 500, `${description.length} characters`);
  assert.doesNotMatch(description, /\b(run|must|always|never install|IMPORTANT)\b/i, 'skill-finder reads an order as an injection');
});

test('writing-skills teaches how search reads a skill and every proof step', () => {
  for (const needle of [
    'name` (weight 4)', 'code blocks never', 'stores no tags', 'headjack enrich', 'A hosted vault', 'tests local mode', // what search reads
    'under 25 characters', 'Delete the box',
    'Use when', 'No orders in the description', 'first sentence with the request', // writing for the index
    '${CLAUDE_SKILL_DIR}/scripts/vault-proof.mjs', 'scratch', '--copy-vault', 'check <box> <slug> <requests-file>',
    'RED, before writing', 'rebuilt from scratch', 'unproven, not done', 'near misses', 'Spanish', // baseline: one search, no misses, no Spanish
    'headjack add <slug> --to claude --session', '~/.claude/skills/<slug>/', '--if-session', // never run from the installed copy
    'skill-finder loaded', 'suggestion block', 'already says yes', 'Haiku', 'commands.log', // never tested end to end; 0/6 searched without the block
    'review` packs every file', 'examples included', // __pycache__ shipped; a warning about curl | sh flagged the skill
    'Publishing is theirs', 'headjack suggest --save --expect <slug>', // the baseline approved into the user's vault
  ]) assert.ok(md.includes(needle), needle);
  assert.ok(existsSync(path.join(ROOT, 'writing-skills/testing.md')), 'testing.md ships beside it');
  assert.doesNotMatch(md, /curl \| sh|\| *sh\b/, 'the skill never shows a pipe-to-shell command, even as a warning');
});
