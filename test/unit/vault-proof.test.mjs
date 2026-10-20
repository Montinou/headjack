// writing-skills/scripts/vault-proof.mjs: the scratch vault and the search proof the writing-skills skill runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeDir, tempDir } from '../helpers.mjs';
import { buildSkillFinderVault } from '../skill-finder-vault.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(ROOT, 'writing-skills/scripts/vault-proof.mjs');

const SKILL = '---\nname: srt-subtitles\ndescription: Use when creating, fixing or retiming SRT or WebVTT subtitle files for a video.\n---\n# SRT subtitles\nCue numbering, timestamps and line length for SRT and VTT captions.\n';

// Runs the script with a clean environment: no HEADJACK_* from the machine running the tests.
async function proof(args, env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HEADJACK_')));
  try {
    const r = await run(process.execPath, [SCRIPT, ...args], { env: { ...base, ...env } });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
}

test('scratch builds a sandbox vault with the skill published, a logging headjack and an env file', async (t) => {
  const work = await tempDir('vp-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const skill = await makeDir({ 'srt-subtitles/SKILL.md': SKILL }, path.join(work, 'src'));
  const box = path.join(work, 'box');
  const r = await proof(['scratch', box, path.join(skill, 'srt-subtitles')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /srt-subtitles: approved/);
  assert.match(r.out, new RegExp(`source ${box.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/env\\.sh`));
  const env = await readFile(path.join(box, 'env.sh'), 'utf8');
  assert.match(env, /export HEADJACK_MODE=local/);
  assert.match(env, /unset HEADJACK_URL HEADJACK_TOKEN/);
  const { stdout } = await run('sh', ['-c', `. '${box}/env.sh' && headjack search "retime srt subtitles" --json && cat '${box}/commands.log'`]);
  assert.match(stdout, /"slug": "srt-subtitles"/);
  assert.match(stdout, /headjack search retime srt subtitles --json/, 'the wrapper logs each call');
  assert.ok((await stat(path.join(box, 'home'))).isDirectory());
});

test('scratch --copy-vault copies the local vault read-only, so the skill competes with the real catalog', async (t) => {
  const work = await tempDir('vp-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const real = await buildSkillFinderVault(path.join(work, 'real'));
  const before = await readFile(path.join(real, 'vault.db'));
  const skill = await makeDir({ 'srt-subtitles/SKILL.md': SKILL }, path.join(work, 'src'));
  const box = path.join(work, 'box');
  const r = await proof(['scratch', box, '--copy-vault', path.join(skill, 'srt-subtitles')], { HEADJACK_HOME: real });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /copied .*\(7 skills\)/);
  const { stdout } = await run('sh', ['-c', `. '${box}/env.sh' && headjack whoami`]);
  assert.match(stdout, /8 skills/);
  assert.deepEqual(await readFile(path.join(real, 'vault.db')), before, 'the real vault is untouched');
});

test('scratch --copy-vault copies the suggestion rule from config.json and nothing else from it', async (t) => {
  const work = await tempDir('vp-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const real = await buildSkillFinderVault(path.join(work, 'real'));
  await writeFile(path.join(real, 'config.json'), JSON.stringify({ token: 'secret-token', url: 'https://example.test', suggest: { enabled: true, rule: { maxRanks: 3 } } }));
  const skill = await makeDir({ 'srt-subtitles/SKILL.md': SKILL }, path.join(work, 'src'));
  const box = path.join(work, 'box');
  const r = await proof(['scratch', box, '--copy-vault', path.join(skill, 'srt-subtitles')], { HEADJACK_HOME: real });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /suggest\.rule: \{"maxRanks":3\}/);
  const copied = JSON.parse(await readFile(path.join(box, 'state', 'config.json'), 'utf8'));
  assert.deepEqual(copied.suggest?.rule, { maxRanks: 3 });
  assert.equal(copied.token, undefined, 'no credentials leave the real config');
  assert.equal(copied.url, undefined);
});

test('check passes when + requests find the skill first and suggest it, and - requests do not; fails naming the line', async (t) => {
  const work = await tempDir('vp-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const real = await buildSkillFinderVault(path.join(work, 'real'));
  // A tiny fixture vault: its bm25 gaps are on a much smaller scale than a real one's, so it carries its own rule
  // (scratch --copy-vault copies suggest.rule).
  await writeFile(path.join(real, 'config.json'), JSON.stringify({ suggest: { rule: { localMinGap: 1.11, localMinGapEs: 1.11 } } }));
  const skill = await makeDir({ 'srt-subtitles/SKILL.md': SKILL }, path.join(work, 'src'));
  const box = path.join(work, 'box');
  assert.equal((await proof(['scratch', box, '--copy-vault', path.join(skill, 'srt-subtitles')], { HEADJACK_HOME: real })).code, 0);

  const good = path.join(work, 'good.txt');
  await writeFile(good, '# expected hits and misses\n+ the captions in my video are out of sync, fix the srt\n+ retime a webvtt subtitle file\n- render an mp4 video from react components with remotion\n');
  const ok = await proof(['check', box, 'srt-subtitles', good]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /3\/3 passed/);

  const bad = path.join(work, 'bad.txt');
  await writeFile(bad, '+ arreglar subtítulos desfasados\n+ fill and flatten a pdf form\n');
  const no = await proof(['check', box, 'srt-subtitles', bad]);
  assert.equal(no.code, 1);
  assert.match(no.out, /FAIL \+ arreglar subtítulos desfasados/);
  assert.match(no.out, /FAIL \+ fill and flatten a pdf form .*pdf-form-filler/, 'names the skill that came first instead');
  assert.match(no.out, /0\/2 passed/);
});

test('scratch shows review flags and treats an unchanged skill as published', async (t) => {
  const work = await tempDir('vp-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const real = await buildSkillFinderVault(path.join(work, 'real'));
  const skill = await makeDir({ 'srt-subtitles/SKILL.md': SKILL, 'srt-subtitles/scripts/fix.mjs': 'console.log(1);\n' }, path.join(work, 'src'));
  const box = path.join(work, "box with 'quote'");
  const r = await proof(['scratch', box, '--copy-vault', path.join(skill, 'srt-subtitles')], { HEADJACK_HOME: real });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /flag: \[low\] script-file scripts\/fix\.mjs/);
  // A second sandbox copied from the first: the same skill is already there, unchanged.
  const again = await proof(['scratch', path.join(work, 'box2'), '--copy-vault', path.join(skill, 'srt-subtitles')], { HEADJACK_HOME: path.join(box, 'state') });
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /srt-subtitles: approved \(unchanged\)/);
});

test('check fails a line that suggest skipped instead of testing it', async (t) => {
  const work = await tempDir('vp-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const skill = await makeDir({ 'srt-subtitles/SKILL.md': SKILL }, path.join(work, 'src'));
  const box = path.join(work, 'box');
  assert.equal((await proof(['scratch', box, path.join(skill, 'srt-subtitles')])).code, 0);
  const file = path.join(work, 'short.txt');
  await writeFile(file, '- pdf form\n');
  const r = await proof(['check', box, 'srt-subtitles', file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL - pdf form .*suggest skipped/);
});

test('usage errors exit 2', async () => {
  assert.equal((await proof([])).code, 2);
  assert.equal((await proof(['check', '/nonexistent'])).code, 2);
});
