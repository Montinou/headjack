// writing-skills/SKILL.md teaches agents to write skills that skill-finder finds. These checks pin what the agent
// evaluation showed it needs, and run the skill's own proof on itself: published next to skill-finder in the fixture
// vault, with no high review flag, it must win the requests in test/fixtures/writing-skills-requests.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.mjs';
import { buildSkillFinderVault } from '../skill-finder-vault.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const md = await readFile(path.join(ROOT, 'writing-skills/SKILL.md'), 'utf8');
const PROOF = path.join(ROOT, 'writing-skills/scripts/vault-proof.mjs');

test('writing-skills has a short "Use when" description with no order in it', () => {
  assert.ok(md.startsWith('---\nname: writing-skills\ndescription: Use when '), 'frontmatter');
  const description = md.split('\n')[2].slice('description: '.length);
  assert.ok(description.length <= 500, `${description.length} characters`);
  assert.doesNotMatch(description, /\b(run|must|always|never install|IMPORTANT)\b/i, 'skill-finder reads an order as an injection');
});

test('writing-skills teaches how search reads a skill and every proof step', () => {
  for (const needle of [
    'name` (weight 4)', 'code blocks never', 'stores no tags', 'headjack enrich', // what search reads
    'Use when', 'No orders in the description', 'first sentence with the request', // writing for the index
    '${CLAUDE_SKILL_DIR}/scripts/vault-proof.mjs', 'scratch', '--copy-vault', 'check <box> <slug> <requests-file>',
    'RED, before writing', 'rebuilt from scratch', 'unproven, not done', 'near misses', 'Spanish', // baseline: one search, no misses, no Spanish
    'headjack add <slug> --to claude --session', '~/.claude/skills/<slug>/', '--if-session', // never run from the installed copy
    'skill-finder loaded', 'suggestion block', 'already says yes', 'Haiku', 'commands.log', // never tested end to end; 0/6 searched without the block
    'review` packs every file', 'examples included', // __pycache__ shipped; a warning about curl | sh flagged the skill
    'Publishing is theirs', 'headjack suggest --save --expect <slug>', // the baseline approved into the user's vault
  ]) assert.ok(md.includes(needle), needle);
  assert.ok(existsSync(path.join(ROOT, 'writing-skills/testing.md')), 'testing.md ships beside it');
  assert.doesNotMatch(md, /curl \| sh|\| *sh\b/, 'a pipe-to-shell pattern, even as a warning, gets a high review flag');
});

test('published next to skill-finder, writing-skills is approved and wins its requests', async (t) => {
  const work = await tempDir('ws-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const real = await buildSkillFinderVault(path.join(work, 'real'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HEADJACK_')));
  const box = path.join(work, 'box');
  const scratch = await run(process.execPath, [PROOF, 'scratch', box, '--copy-vault', path.join(ROOT, 'writing-skills'), path.join(ROOT, 'skill-finder')],
    { env: { ...env, HEADJACK_HOME: real } });
  assert.match(scratch.stdout, /writing-skills: approved/);
  assert.match(scratch.stdout, /skill-finder: approved/);
  assert.doesNotMatch(scratch.stdout, /\[high\]/);
  const check = await run(process.execPath, [PROOF, 'check', box, 'writing-skills', path.join(ROOT, 'test/fixtures/writing-skills-requests.txt')], { env })
    .catch((e) => assert.fail(e.stdout));
  assert.match(check.stdout, /14\/14 passed/);
});
