import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { HARNESSES, KNOWN_HARNESSES, parseHarnessList, skillsDir, detectHarnesses, loadHarnesses } from '../../cli/harness.mjs';
import { UserError } from '../../lib/errors.mjs';
import { tempDir } from '../helpers.mjs';

const TABLE = {
  gemini: '.gemini/skills', cursor: '.cursor/skills', continue: '.continue/skills', copilot: '.copilot/skills',
  kiro: '.kiro/skills', factory: '.factory/skills', openclaw: '.openclaw/skills', roo: '.roo/skills',
  kilocode: '.kilocode/skills', qwen: '.qwen/skills', trae: '.trae/skills', qoder: '.qoder/skills',
  junie: '.junie/skills', zencoder: '.zencoder/skills', codebuddy: '.codebuddy/skills', commandcode: '.commandcode/skills',
  openhands: '.openhands/skills', neovate: '.neovate/skills', pochi: '.pochi/skills', kode: '.kode/skills',
  mux: '.mux/skills', windsurf: '.codeium/windsurf/skills', cline: '.cline/skills', pi: '.pi/agent/skills',
};

test('KNOWN_HARNESSES has the built-in trio plus the 24 measured tools', () => {
  assert.deepEqual(HARNESSES, ['claude', 'codex', 'grok']);
  for (const h of HARNESSES) assert.deepEqual(KNOWN_HARNESSES[h], { global: `.${h}/skills`, project: `.${h}/skills` }, h);
  for (const [id, dir] of Object.entries(TABLE)) assert.equal(KNOWN_HARNESSES[id]?.global, dir, id);
  assert.equal(Object.keys(KNOWN_HARNESSES).length, 27);
  assert.deepEqual(Object.keys(KNOWN_HARNESSES).slice(0, 3), HARNESSES);
});

test('skillsDir resolves the table; --project needs a project dir', () => {
  assert.equal(skillsDir('codex', { home: '/h', cwd: '/p' }), '/h/.codex/skills');
  assert.equal(skillsDir('claude', { home: '/h', cwd: '/p', project: true }), '/p/.claude/skills');
  assert.equal(skillsDir('windsurf', { home: '/h', cwd: '/p' }), '/h/.codeium/windsurf/skills');
  assert.equal(skillsDir('pi', { home: '/h', cwd: '/p' }), '/h/.pi/agent/skills');
  assert.throws(() => skillsDir('gemini', { home: '/h', cwd: '/p', project: true }), (e) => e instanceof UserError && /gemini/.test(e.message));
  assert.throws(() => skillsDir('nope', { home: '/h', cwd: '/p' }), UserError);
});

test('parseHarnessList accepts any known id and "all" (= detected)', () => {
  assert.deepEqual(parseHarnessList(), ['claude', 'codex', 'grok']);
  assert.deepEqual(parseHarnessList('gemini, cursor'), ['gemini', 'cursor']);
  assert.deepEqual(parseHarnessList('all', ['claude', 'gemini']), ['claude', 'gemini']);
  assert.deepEqual(parseHarnessList('all'), ['claude', 'codex', 'grok'], 'no detection → trio');
  assert.deepEqual(parseHarnessList('claude,all', ['claude', 'pi']), ['claude', 'pi'], 'deduped');
  assert.throws(() => parseHarnessList('frobnicate'), (e) => e instanceof UserError && /frobnicate/.test(e.message) && /windsurf/.test(e.message) && /all/.test(e.message));
});

test('detectHarnesses writes the ids whose global dir exists; loadHarnesses reads them back', async () => {
  const home = await tempDir('sv-home-');
  const dir = path.join(home, '.headjack');
  assert.deepEqual(await loadHarnesses({ home, dir }), ['claude', 'codex', 'grok'], 'missing file → trio');
  for (const rel of ['.claude/skills', '.gemini/skills', '.codeium/windsurf/skills']) await mkdir(path.join(home, rel), { recursive: true });
  await mkdir(path.join(home, '.cursor'), { recursive: true }); // tool dir without skills/ → not detected
  await mkdir(path.join(home, '.agents/skills'), { recursive: true });
  await symlink('../.agents/skills', path.join(home, '.pi')); // ~/.pi/agent/skills does not resolve
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await symlink('../.agents/skills', path.join(home, '.codex/skills')); // a symlinked skills dir still counts
  const found = await detectHarnesses({ home, dir });
  assert.deepEqual(found, ['claude', 'codex', 'gemini', 'windsurf']);
  const saved = JSON.parse(await readFile(path.join(dir, 'harnesses.json'), 'utf8'));
  assert.deepEqual(saved.harnesses, found);
  assert.deepEqual(await loadHarnesses({ home, dir }), found);
  const envHome = process.env.HEADJACK_HOME;
  delete process.env.HEADJACK_HOME;
  try { assert.deepEqual(await loadHarnesses({ home }), found, 'dir defaults to ~/.headjack'); } finally { if (envHome !== undefined) process.env.HEADJACK_HOME = envHome; }
});

test('loadHarnesses rejects a corrupt file and ignores unknown ids', async () => {
  const home = await tempDir('sv-home-');
  const dir = path.join(home, '.headjack');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'harnesses.json'), '{ nope');
  await assert.rejects(loadHarnesses({ home, dir }), (e) => e instanceof UserError && /harnesses\.json/.test(e.message));
  await writeFile(path.join(dir, 'harnesses.json'), JSON.stringify({ harnesses: ['gemini', 'gone-tool'] }));
  assert.deepEqual(await loadHarnesses({ home, dir }), ['gemini']);
});
