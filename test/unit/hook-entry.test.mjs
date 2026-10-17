// cli/hook-entry.mjs: the lean process the plugin hooks run (node, no sh launcher). A disabled `prompt`/`warmup` must end
// after reading the suggest config, without loading the pipeline; every failure is no output and exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { buildSyntheticVault } from '../synthetic-vault.mjs';
import { traceSupported } from '../trace-imports.mjs';
import { readEvents } from '../../lib/suggest-log.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = path.join(ROOT, 'cli/hook-entry.mjs');
const TRACE = fileURLToPath(new URL('../trace-imports.mjs', import.meta.url));
const SESSION = 'entry-session-1';
const PLANTED = {
  slug: 'zorblax-quillwright',
  name: 'zorblax-quillwright',
  description: 'Quillwright zorblax manifests: sync glimmerfox tapestries across vellumstack ledgers',
  body: 'Use quillwright to reconcile zorblax manifests. Each glimmerfox tapestry maps to one vellumstack ledger entry.',
};
const PROMPT = 'I need to reconcile the zorblax manifests and sync every glimmerfox tapestry into the vellumstack ledgers';
const promptJson = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: '/nowhere', prompt: PROMPT });
const skillJson = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Skill', tool_input: { skill: 'zorblax-quillwright' } });

async function sandbox({ config } = {}) {
  const home = await tempDir('sv-entry-home-');
  const dir = path.join(home, 'hj');
  await fsp.mkdir(dir, { recursive: true });
  if (config !== undefined) await fsp.writeFile(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return { home, dir };
}

// Runs the entry like Claude Code does; `modules` are the file URLs the process resolved (when the trace is supported).
async function runEntry(args, box, { stdin = '', env = {}, trace = true } = {}) {
  const traceFile = path.join(box.home, 'trace.txt');
  const child = spawn('node', [...(trace && traceSupported ? ['--import', pathToFileURL(TRACE).href] : []), ENTRY, ...args], {
    env: { PATH: process.env.PATH, HOME: box.home, HEADJACK_HOME: box.dir, HEADJACK_TRACE_FILE: traceFile, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(stdin);
  const started = performance.now();
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const ms = performance.now() - started;
  const modules = (await fsp.readFile(traceFile, 'utf8').catch(() => '')).split('\n').filter((u) => u.startsWith('file:')).map((u) => path.relative(ROOT, fileURLToPath(u)));
  return { code, stdout, stderr, ms, modules };
}

const loaded = (res, file) => res.modules.includes(file);
const traced = (name, fn) => test(name, { skip: traceSupported ? false : 'module.registerHooks needs Node 22.15+' }, fn);

for (const name of ['prompt', 'warmup']) {
  traced(`${name}: suggest disabled exits 0 with no output and never loads the pipeline`, async () => {
    for (const config of [undefined, { suggest: { enabled: false } }, { suggest: {} }, { unrelated: true }]) {
      const box = await sandbox({ config });
      const res = await runEntry([name], box, { stdin: promptJson });
      assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', ''], JSON.stringify(config));
      assert.ok(loaded(res, 'lib/suggest-config.mjs'), 'it read the suggest config');
      for (const heavy of ['cli/hook.mjs', 'lib/suggest.mjs', 'cli/headjack.mjs', 'cli/suggest-deps.mjs', 'lib/suggest-local.mjs', 'lib/suggest-hosted.mjs']) {
        assert.equal(loaded(res, heavy), false, `${heavy} was loaded (${JSON.stringify(config)})`);
      }
      assert.equal(await fsp.stat(path.join(box.dir, 'suggest')).catch(() => null), null, 'nothing is written');
    }
  });
}

localTest('prompt: suggest enabled loads the pipeline and prints the hook JSON naming the skill', async () => {
  const box = await sandbox({ config: { suggest: { enabled: true } } });
  await buildSyntheticVault(box.dir, { skills: 50, planted: [PLANTED] });
  const res = await runEntry(['prompt'], box, { stdin: promptJson });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(PLANTED.slug));
  if (traceSupported) assert.ok(loaded(res, 'lib/suggest.mjs') && loaded(res, 'cli/hook.mjs'));
});

localTest('skill-used: with suggestions enabled it maps the slug, logs one invoke and loads no pipeline', async () => {
  const box = await sandbox({ config: { suggest: { enabled: true } } });
  await buildSyntheticVault(box.dir, { skills: 5, planted: [PLANTED] });
  const res = await runEntry(['skill-used'], box, { stdin: skillJson });
  assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', '']);
  const [event, ...rest] = (await readEvents(box.dir)).filter((e) => e.type === 'invoke');
  assert.equal(rest.length, 0);
  assert.deepEqual([event.session, event.skill, event.slug], [SESSION, PLANTED.slug, PLANTED.slug]);
  if (traceSupported) {
    assert.ok(loaded(res, 'cli/hook.mjs'));
    assert.equal(loaded(res, 'lib/suggest.mjs'), false, 'the pipeline stays unloaded');
  }
});

localTest('skill-used: with suggestions never enabled it writes nothing, not even the suggest directory', async () => {
  for (const config of [undefined, { suggest: { enabled: false } }, { suggest: {} }, { unrelated: true }]) {
    const box = await sandbox({ config });
    await buildSyntheticVault(box.dir, { skills: 5, planted: [PLANTED] });
    const res = await runEntry(['skill-used'], box, { stdin: skillJson, trace: false });
    assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', ''], JSON.stringify(config));
    assert.equal(await fsp.stat(path.join(box.dir, 'suggest')).catch(() => null), null, `no suggest directory (${JSON.stringify(config)})`);
  }
});

test('a malformed config.json falls through to the full hook: no output, one hook.log line, exit 0', async () => {
  const box = await sandbox({ config: '{ not json' });
  const res = await runEntry(['prompt'], box, { stdin: promptJson });
  assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', '']);
  const log = (await fsp.readFile(path.join(box.dir, 'suggest', 'hook.log'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).hook, 'prompt');
});

test('unknown hooks, no hook, garbage stdin and a relative HEADJACK_HOME print nothing and exit 0', async () => {
  const box = await sandbox({ config: { suggest: { enabled: true } } });
  for (const [args, stdin, env] of [
    [['bogus'], promptJson, {}], [[], '', {}], [['prompt'], '{{{', {}], [['skill-used'], '{{{', {}], [['prompt'], promptJson, { HEADJACK_HOME: 'relative/dir' }],
  ]) {
    const res = await runEntry(args, box, { stdin, env });
    assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', ''], JSON.stringify([args, env]));
  }
});

test('with HEADJACK_PERF=1 a disabled prompt hook finishes in a lean budget', { skip: process.env.HEADJACK_PERF === '1' ? false : 'HEADJACK_PERF=1 enables timing assertions' }, async () => {
  const box = await sandbox();
  const times = [];
  for (let i = 0; i < 5; i += 1) times.push((await runEntry(['prompt'], box, { stdin: promptJson, trace: false })).ms);
  times.sort((a, b) => a - b);
  assert.ok(times[2] < 250, `median ${times[2]} ms (all: ${times.join(', ')})`);
});
