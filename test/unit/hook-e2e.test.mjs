// End to end: the real launcher (cli/headjack) running `hook prompt` the way Claude Code does, over a synthetic vault
// with one planted skill. Also the guarantee that `hook` is dispatched before option parsing (spec §4.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { buildSyntheticVault } from '../synthetic-vault.mjs';

const LAUNCHER = fileURLToPath(new URL('../../cli/headjack', import.meta.url));
const SESSION = 'e2e-session-1';
const PLANTED = {
  slug: 'zorblax-quillwright',
  name: 'zorblax-quillwright',
  description: 'Quillwright zorblax manifests: sync glimmerfox tapestries across vellumstack ledgers',
  body: 'Use quillwright to reconcile zorblax manifests. Each glimmerfox tapestry maps to one vellumstack ledger entry.',
};
const MATCHING_PROMPT = 'I need to reconcile the zorblax manifests and sync every glimmerfox tapestry into the vellumstack ledgers';
const UNRELATED_PROMPT = 'what is the weather like in lisbon tomorrow afternoon';

// { home, dir }: a temp HOME and a state dir holding a synthetic vault with the planted skill and suggest enabled.
async function sandbox() {
  const home = await tempDir('sv-e2e-home-');
  const dir = path.join(home, 'hj');
  await fsp.mkdir(dir, { recursive: true });
  await buildSyntheticVault(dir, { skills: 50, planted: [PLANTED] });
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ suggest: { enabled: true } }));
  return { home, dir };
}

const hookJson = (prompt) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: '/nowhere', prompt });

function runLauncher(args, { env, stdin = '' }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(LAUNCHER, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

localTest('hook prompt over a planted skill prints the hook JSON naming it, inside the time budget', async () => {
  const box = await sandbox();
  const res = await runLauncher(['hook', 'prompt'], { env: { HOME: box.home, HEADJACK_HOME: box.dir }, stdin: hookJson(MATCHING_PROMPT) });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(PLANTED.slug), out.hookSpecificOutput.additionalContext);
  assert.ok(res.ms < 3000, `took ${res.ms} ms`);
  if (process.env.HEADJACK_PERF === '1') assert.ok(res.ms < 1000, `took ${res.ms} ms (HEADJACK_PERF=1 budget is 1000 ms)`);
});

localTest('hook prompt with an unrelated prompt prints nothing and exits 0', async () => {
  const box = await sandbox();
  const res = await runLauncher(['hook', 'prompt'], { env: { HOME: box.home, HEADJACK_HOME: box.dir }, stdin: hookJson(UNRELATED_PROMPT) });
  assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', '']);
});

test('hook is dispatched before option parsing: --help and unknown options print nothing and exit 0', async () => {
  const home = await tempDir('sv-e2e-home-');
  const env = { HOME: home, HEADJACK_HOME: path.join(home, 'hj') };
  for (const args of [['hook', 'prompt', '--help'], ['hook', 'prompt', '-h'], ['hook', 'warmup', '--bogus'], ['hook', '--help'], ['hook', 'prompt', '--to']]) {
    const res = await runLauncher(args, { env, stdin: '' });
    assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', ''], args.join(' '));
  }
});
