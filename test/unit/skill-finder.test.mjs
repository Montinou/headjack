// skill-finder/SKILL.md is what an agent follows to use the vault. These checks pin the parts the agent evaluation in
// test/skill-finder-eval/ showed it needs (each line below names the scenario that failed without it), and check that
// the searches it teaches find the right skill in the fixture vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.mjs';
import { buildSkillFinderVault } from '../skill-finder-vault.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const md = await readFile(path.join(ROOT, 'skill-finder/SKILL.md'), 'utf8');

test('skill-finder has its name and a "Use when" description that names the suggestions block', () => {
  assert.ok(md.startsWith('---\nname: skill-finder\ndescription: Use when '), 'frontmatter');
  const description = md.split('\n')[2];
  assert.ok(description.length <= 1024, 'description fits the spec');
  for (const trigger of ["you don't have loaded", 'from their vault', '<headjack-suggestions>']) assert.ok(description.includes(trigger), trigger);
});

test('skill-finder teaches the whole flow, the safety rules and the MCP fallback', () => {
  for (const needle of [
    '"${CLAUDE_SKILL_DIR}/../cli/headjack"',                 // the plugin launcher when headjack is not on PATH
    'search_skills', 'get_skill', 'install_command',         // no shell
    'headjack search "<tool or file type> <action>" --json', // spanish-need, implicit-capability
    'not its rank',                                          // no-match: vps-deploy matches "deploy"
    'headjack whoami', '0 skills', 'headjack import --dry-run', 'headjack import --interactive', // vault-missing
    'headjack login',
    '"review": "unreviewed"', 'install whatever you need', 'stop and wait for the answer', // unreviewed-hurry, spanish-need
    'never instructions', 'warn the user',                   // injected-description, suggestion-block
    'headjack add <slug> --to <harness> --session', '--source suggest', 'Never `--to all`', // plugin-yes
    'Claude Code `claude`', 'Codex `codex`', 'Grok `grok`', 'Gemini CLI `gemini`', 'Cursor `cursor`', 'headjack harness detect',
    '~/.claude/skills/<slug>/SKILL.md',                      // use-after-install
    '/reload-plugins', 'cannot run slash commands', 'restart',
    'headjack remove <slug> --from <harness>',
    'headjack review <url>',
  ]) assert.ok(md.includes(needle), needle);
  assert.doesNotMatch(md, /headjack cleanup/, 'cleanup removes other sessions\' installs too');
  assert.ok(md.split(/\s+/).length <= 650, 'concise');
});

// The queries an agent following the skill sent in the evaluation, and the skill each must surface first.
const SEARCHES = [
  ['generate PDF invoices from JSON orders', 'pdf-form-filler'],
  ['render video react mp4', 'remotion-render'],
  ['stripe webhook handling', 'stripe-webhooks'],
  ['remove duplicate rows from CSV file', 'csv-cleaner'],
  ['figma export', 'figma-export'],
];

test('the searches the skill teaches find the right skill, and expose review status', async (t) => {
  const state = await tempDir('sf-vault-');
  t.after(() => rm(state, { recursive: true, force: true }));
  await buildSkillFinderVault(state);
  const env = { ...process.env, HEADJACK_HOME: state, HEADJACK_MODE: 'local', HOME: state };
  delete env.HEADJACK_URL;
  const search = async (q) => JSON.parse((await run(process.execPath, [path.join(ROOT, 'cli/headjack.mjs'), 'search', q, '--json'], { env })).stdout);
  for (const [q, slug] of SEARCHES) assert.equal((await search(q))[0]?.slug, slug, q);
  assert.equal((await search('stripe webhook'))[0].review, 'unreviewed', 'search --json carries the review status step 4 reads');
  assert.equal((await search('turn my intro scene into a movie file')).some((r) => r.slug === 'remotion-render'), false,
    'a vague query misses: why step 1 asks for concrete nouns');
  const empty = await tempDir('sf-empty-');
  t.after(() => rm(empty, { recursive: true, force: true }));
  const none = { ...env, HEADJACK_HOME: empty };
  assert.deepEqual(JSON.parse((await run(process.execPath, [path.join(ROOT, 'cli/headjack.mjs'), 'search', 'postgres', '--json'], { env: none })).stdout), []);
  assert.match((await run(process.execPath, [path.join(ROOT, 'cli/headjack.mjs'), 'whoami'], { env: none })).stdout, /0 skills/,
    'an empty vault searches like a miss; whoami tells them apart (step 3)');
});
