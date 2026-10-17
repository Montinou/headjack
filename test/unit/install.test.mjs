import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readlink, readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { add, remove, list, verify, gc, storeDir, cleanup, parseDuration, resolveEntry } from '../../cli/install.mjs';
import { loadState, saveState } from '../../cli/state.mjs';
import { UserError } from '../../lib/errors.mjs';
import { fakeApi } from '../fake-api.mjs';
import { tempDir, file, captureLog } from '../helpers.mjs';
import { readEvents } from '../../lib/suggest-log.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const files = [file('SKILL.md', '---\nname: demo\n---\n# Demo'), file('ref/notes.md', 'notes')];

async function setup() {
  const home = await tempDir('sv-home-');
  const cwd = await tempDir('sv-proj-');
  const api = fakeApi();
  const sha = api.addSkill({ slug: 'demo', files });
  const ctx = { api, home, cwd, env: {}, dir: path.join(home, '.headjack'), log: captureLog() };
  return { home, cwd, api, sha, ctx };
}

test('add links the skill into all three harnesses and records state', async () => {
  const { home, sha, ctx } = await setup();
  await add('demo', {}, ctx);
  const expected = path.join(storeDir(ctx.dir), sha, 'demo');
  for (const h of ['claude', 'codex', 'grok']) {
    const link = path.join(home, `.${h}`, 'skills', 'demo');
    assert.ok((await lstat(link)).isSymbolicLink(), h);
    assert.equal(await readlink(link), expected);
  }
  assert.equal(await readFile(path.join(expected, 'ref/notes.md'), 'utf8'), 'notes');
  const state = await loadState(ctx.dir);
  assert.equal(state.active[0].sha256, sha);
  assert.equal(state.active[0].targets.length, 3);
  assert.match(ctx.log.text(), /restart it to load the skill/);
});

test('add --to and --project', async () => {
  const { home, cwd, ctx } = await setup();
  await add('demo', { to: 'claude', project: true }, ctx);
  assert.ok(await exists(path.join(cwd, '.claude', 'skills', 'demo')));
  assert.ok(!(await exists(path.join(home, '.claude', 'skills', 'demo'))));
  assert.ok(!(await exists(path.join(cwd, '.codex', 'skills', 'demo'))));
});

test('add is idempotent', async () => {
  const { ctx } = await setup();
  await add('demo', {}, ctx);
  await add('demo', {}, ctx);
  assert.equal((await loadState(ctx.dir)).active[0].targets.length, 3);
});

test('add refuses to overwrite an unmanaged destination', async () => {
  const { home, ctx } = await setup();
  const mine = path.join(home, '.codex', 'skills', 'demo');
  await mkdir(mine, { recursive: true });
  await writeFile(path.join(mine, 'SKILL.md'), 'mine');
  await assert.rejects(add('demo', {}, ctx), (e) => e instanceof UserError && /headjack does not manage it/.test(e.message));
  assert.equal(await readFile(path.join(mine, 'SKILL.md'), 'utf8'), 'mine');
  assert.ok(!(await exists(path.join(home, '.claude', 'skills', 'demo'))), 'no partial links');
  assert.ok(!(await exists(storeDir(ctx.dir))), 'no store write');
  assert.deepEqual((await loadState(ctx.dir)).active, []);
});

test('failed or tampered download leaves no trace', async () => {
  for (const breakIt of [
    (api) => api.failDownload('demo', new Error('network down')),
    (api) => api.tamper('demo', [file('SKILL.md', 'evil')]),
  ]) {
    const { home, api, ctx } = await setup();
    breakIt(api);
    await assert.rejects(add('demo', {}, ctx));
    assert.ok(!(await exists(path.join(home, '.claude', 'skills', 'demo'))));
    const store = storeDir(ctx.dir);
    const leftovers = (await exists(store)) ? await readdir(store) : [];
    assert.deepEqual(leftovers, [], 'no store entries or tmp dirs');
    assert.deepEqual((await loadState(ctx.dir)).active, []);
  }
});

test('add of a plugin or plugin skill toggles enabledPlugins only', async () => {
  const { home, api, ctx } = await setup();
  api.addSkill({ slug: 'noncore-plugin@example', kind: 'plugin' });
  api.addSkill({ slug: 'noncore-plugin@example:webapp', plugin_slug: 'noncore-plugin@example' });
  const settings = path.join(home, '.claude', 'settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ model: 'opus', enabledPlugins: { 'other@m': true } }));
  await add('noncore-plugin@example:webapp', {}, ctx);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { model: 'opus', enabledPlugins: { 'other@m': true, 'noncore-plugin@example': true } });
  const entry = (await loadState(ctx.dir)).active[0];
  assert.equal(entry.slug, 'noncore-plugin@example');
  assert.equal(entry.kind, 'plugin');
  await remove('noncore-plugin@example', {}, ctx);
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['noncore-plugin@example'], false);
  assert.deepEqual((await loadState(ctx.dir)).active, []);
});

test('add of unknown or unapproved skill fails clearly', async () => {
  const { api, ctx } = await setup();
  await assert.rejects(add('nope', {}, ctx), /"nope" is not in the vault; try: headjack search /);
  api.addSkill({ slug: 'pending' });
  await assert.rejects(add('pending', {}, ctx), /has no approved version/);
});

test('remove unlinks managed links, keeps the store and honors --from', async () => {
  const { home, sha, ctx } = await setup();
  await add('demo', {}, ctx);
  await remove('demo', { from: 'grok' }, ctx);
  assert.ok(!(await exists(path.join(home, '.grok', 'skills', 'demo'))));
  assert.ok(await exists(path.join(home, '.claude', 'skills', 'demo')));
  await remove('demo', {}, ctx);
  assert.ok(!(await exists(path.join(home, '.claude', 'skills', 'demo'))));
  assert.deepEqual((await loadState(ctx.dir)).active, []);
  assert.ok(await exists(path.join(storeDir(ctx.dir), sha, 'demo')));
  await assert.rejects(remove('demo', {}, ctx), /is not active \(see headjack list;/);
});

test('remove leaves a destination that is no longer ours', async () => {
  const { home, ctx } = await setup();
  await add('demo', { to: 'claude' }, ctx);
  const link = path.join(home, '.claude', 'skills', 'demo');
  const { rm } = await import('node:fs/promises');
  await rm(link);
  await mkdir(link);
  await remove('demo', {}, ctx);
  assert.ok((await lstat(link)).isDirectory());
  assert.match(ctx.log.text(), /is no longer an headjack symlink/);
});

test('verify detects edited files and hijacked links; gc prunes unreferenced store', async () => {
  const { home, sha, ctx } = await setup();
  await add('demo', {}, ctx);
  assert.deepEqual(await verify(ctx), []);
  await writeFile(path.join(storeDir(ctx.dir), sha, 'demo', 'SKILL.md'), 'edited');
  const problems = await verify(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /modified on disk/);
  const { rm, symlink } = await import('node:fs/promises');
  const link = path.join(home, '.codex', 'skills', 'demo');
  await rm(link);
  await symlink('/tmp', link);
  assert.equal((await verify(ctx)).length, 2);
  await remove('demo', {}, ctx);
  assert.deepEqual(await gc(ctx), [sha]);
  assert.deepEqual(await readdir(storeDir(ctx.dir)), []);
});

test('list returns active entries', async () => {
  const { ctx } = await setup();
  assert.deepEqual(await list(ctx), []);
  await add('demo', { to: 'claude' }, ctx);
  assert.deepEqual((await list(ctx)).map((e) => e.slug), ['demo']);
});

// --- Final fix wave ---

test('add of a plugin that is already enabled does not take ownership, so remove cannot disable it', async () => {
  const { home, api, ctx } = await setup();
  api.addSkill({ slug: 'superpowers@superpowers-marketplace', kind: 'plugin' });
  api.addSkill({ slug: 'superpowers@superpowers-marketplace:brainstorming', plugin_slug: 'superpowers@superpowers-marketplace' });
  const settings = path.join(home, '.claude', 'settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  const before = JSON.stringify({ model: 'opus', enabledPlugins: { 'superpowers@superpowers-marketplace': true } });
  await writeFile(settings, before);
  for (const slug of ['superpowers@superpowers-marketplace', 'superpowers@superpowers-marketplace:brainstorming']) {
    await add(slug, {}, ctx);
    assert.equal(await readFile(settings, 'utf8'), before, 'settings untouched');
    assert.deepEqual((await loadState(ctx.dir)).active, [], 'no state entry');
  }
  assert.match(ctx.log.text(), /plugin superpowers@superpowers-marketplace was already enabled; headjack does not manage it/);
  await assert.rejects(remove('superpowers@superpowers-marketplace', {}, ctx), (e) => e instanceof UserError && /is not active/.test(e.message));
  assert.equal(await readFile(settings, 'utf8'), before);
});

test('re-adding a plugin headjack enabled itself stays managed', async () => {
  const { home, api, ctx } = await setup();
  api.addSkill({ slug: 'noncore-plugin@example', kind: 'plugin' });
  await add('noncore-plugin@example', {}, ctx);
  await add('noncore-plugin@example', {}, ctx);
  assert.equal((await loadState(ctx.dir)).active.length, 1);
  await remove('noncore-plugin@example', {}, ctx);
  const settings = path.join(home, '.claude', 'settings.json');
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['noncore-plugin@example'], false);
});

// --- Harness registry ---

test('add --to accepts any known harness and "all" (= detected)', async () => {
  const { home, sha, ctx } = await setup();
  await add('demo', { to: 'gemini,windsurf' }, ctx);
  const expected = path.join(storeDir(ctx.dir), sha, 'demo');
  assert.equal(await readlink(path.join(home, '.gemini/skills/demo')), expected);
  assert.equal(await readlink(path.join(home, '.codeium/windsurf/skills/demo')), expected);
  assert.ok(!(await exists(path.join(home, '.claude/skills/demo'))));
  await mkdir(ctx.dir, { recursive: true });
  await writeFile(path.join(ctx.dir, 'harnesses.json'), JSON.stringify({ harnesses: ['claude', 'pi'] }));
  await add('demo', { to: 'all' }, ctx);
  assert.equal(await readlink(path.join(home, '.pi/agent/skills/demo')), expected);
  assert.deepEqual((await loadState(ctx.dir)).active[0].targets.map((t) => t.harness).sort(), ['claude', 'gemini', 'pi', 'windsurf']);
  await remove('demo', { from: 'windsurf,pi' }, ctx);
  assert.ok(!(await exists(path.join(home, '.pi/agent/skills/demo'))));
  assert.ok(await exists(path.join(home, '.gemini/skills/demo')));
});

test('add --project into a harness without a project dir fails before touching anything', async () => {
  const { cwd, ctx } = await setup();
  await assert.rejects(add('demo', { to: 'claude,gemini', project: true }, ctx), (e) => e instanceof UserError && /gemini/.test(e.message));
  assert.ok(!(await exists(path.join(cwd, '.claude'))));
  assert.ok(!(await exists(storeDir(ctx.dir))));
});

// --- Session-scoped installs ---

const isIso = (s) => typeof s === 'string' && new Date(s).toISOString() === s;

test('add --session marks the entry (skill and plugin) with session and addedAt', async () => {
  const { api, ctx } = await setup();
  api.addSkill({ slug: 'noncore-plugin@example', kind: 'plugin' });
  const before = Date.now();
  await add('demo', { to: 'claude', session: true }, ctx);
  await add('noncore-plugin@example', { session: true }, ctx);
  const [skill, plugin] = (await loadState(ctx.dir)).active;
  for (const e of [skill, plugin]) {
    assert.equal(e.session, true, e.slug);
    assert.ok(isIso(e.addedAt), e.slug);
    assert.ok(Date.parse(e.addedAt) >= before - 1000, e.slug);
  }
});

test('a later non-session add makes a session entry permanent', async () => {
  const { api, ctx } = await setup();
  api.addSkill({ slug: 'noncore-plugin@example', kind: 'plugin' });
  await add('demo', { to: 'claude', session: true }, ctx);
  await add('noncore-plugin@example', { session: true }, ctx);
  await add('demo', { to: 'codex' }, ctx);
  await add('noncore-plugin@example', {}, ctx);
  for (const e of (await loadState(ctx.dir)).active) {
    assert.equal(e.session, undefined, e.slug);
    assert.equal(e.addedAt, undefined, e.slug);
  }
});

test('a session add over a permanent entry leaves it permanent', async () => {
  const { ctx } = await setup();
  await add('demo', { to: 'claude' }, ctx);
  await add('demo', { to: 'gemini', session: true }, ctx);
  const [e] = (await loadState(ctx.dir)).active;
  assert.equal(e.session, undefined);
  assert.deepEqual(e.targets.map((t) => t.harness).sort(), ['claude', 'gemini']);
});

async function sessionSetup() {
  const s = await setup();
  s.api.addSkill({ slug: 'keep', files: [file('SKILL.md', '---\nname: keep\n---\n# Keep')] });
  s.api.addSkill({ slug: 'noncore-plugin@example', kind: 'plugin' });
  await add('keep', { to: 'claude' }, s.ctx); // permanent
  await add('demo', { to: 'claude,gemini', session: true }, s.ctx);
  await add('noncore-plugin@example', { session: true }, s.ctx);
  s.settings = path.join(s.home, '.claude', 'settings.json');
  return s;
}
const slugs = async (ctx) => (await loadState(ctx.dir)).active.map((e) => e.slug).sort();

test('cleanup removes only session entries through remove: managed links go, plugins are disabled', async () => {
  const { home, ctx, settings } = await sessionSetup();
  const removed = await cleanup({}, ctx);
  assert.deepEqual(removed.map((r) => r.slug).sort(), ['demo', 'noncore-plugin@example']);
  assert.deepEqual(removed.find((r) => r.slug === 'demo').harnesses.sort(), ['claude', 'gemini']);
  assert.ok(!(await exists(path.join(home, '.claude/skills/demo'))));
  assert.ok(!(await exists(path.join(home, '.gemini/skills/demo'))));
  assert.ok((await lstat(path.join(home, '.claude/skills/keep'))).isSymbolicLink(), 'permanent entry untouched');
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['noncore-plugin@example'], false);
  assert.deepEqual(await slugs(ctx), ['keep']);
  assert.deepEqual(await cleanup({}, ctx), [], 'nothing left is not an error');
});

test('cleanup --harness only touches targets of those harnesses', async () => {
  const { home, ctx, settings } = await sessionSetup();
  const removed = await cleanup({ harness: 'gemini' }, ctx);
  assert.deepEqual(removed, [{ slug: 'demo', kind: 'skill', harnesses: ['gemini'] }]);
  assert.ok(!(await exists(path.join(home, '.gemini/skills/demo'))));
  assert.ok((await lstat(path.join(home, '.claude/skills/demo'))).isSymbolicLink());
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['noncore-plugin@example'], true, 'plugin lives in claude');
  const demo = (await loadState(ctx.dir)).active.find((e) => e.slug === 'demo');
  assert.equal(demo.session, true, 'still a session entry');
  assert.deepEqual(demo.targets.map((t) => t.harness), ['claude']);
  assert.deepEqual((await cleanup({ harness: 'claude' }, ctx)).map((r) => r.slug).sort(), ['demo', 'noncore-plugin@example']);
  assert.deepEqual(await slugs(ctx), ['keep']);
});

test('cleanup --older-than only touches entries added before that', async () => {
  const { ctx } = await sessionSetup();
  const state = await loadState(ctx.dir);
  state.active.find((e) => e.slug === 'demo').addedAt = new Date(Date.now() - 3 * 3600e3).toISOString();
  await saveState(ctx.dir, state);
  assert.deepEqual((await cleanup({ olderThan: '4h' }, ctx)), []);
  assert.deepEqual((await cleanup({ olderThan: '2h' }, ctx)).map((r) => r.slug), ['demo']);
  assert.deepEqual(await slugs(ctx), ['keep', 'noncore-plugin@example']);
});

test('cleanup --dry-run reports and changes nothing', async () => {
  const { home, ctx, settings } = await sessionSetup();
  const stateBefore = await readFile(path.join(ctx.dir, 'state.json'), 'utf8');
  const settingsBefore = await readFile(settings, 'utf8');
  const would = await cleanup({ dryRun: true }, ctx);
  assert.deepEqual(would.map((r) => r.slug).sort(), ['demo', 'noncore-plugin@example']);
  assert.equal(await readFile(path.join(ctx.dir, 'state.json'), 'utf8'), stateBefore);
  assert.equal(await readFile(settings, 'utf8'), settingsBefore);
  assert.ok((await lstat(path.join(home, '.gemini/skills/demo'))).isSymbolicLink());
});

test('cleanup with no state is a no-op; a hijacked session link is left in place', async () => {
  const { home, ctx } = await setup();
  assert.deepEqual(await cleanup({}, ctx), []);
  await add('demo', { to: 'claude', session: true }, ctx);
  const link = path.join(home, '.claude/skills/demo');
  const { rm } = await import('node:fs/promises');
  await rm(link);
  await mkdir(link);
  await cleanup({}, ctx);
  assert.ok((await lstat(link)).isDirectory());
  assert.match(ctx.log.text(), /is no longer an headjack symlink/);
});

test('parseDuration accepts m, h and d', () => {
  assert.equal(parseDuration('30m'), 30 * 60e3);
  assert.equal(parseDuration('12h'), 12 * 3600e3);
  assert.equal(parseDuration('2d'), 2 * 86400e3);
  for (const bad of ['12', 'h', '1w', '-1h', '1.5h', '']) assert.throws(() => parseDuration(bad), (e) => e instanceof UserError && /--older-than/.test(e.message), bad);
});

// --- Fix round 1 (harness lifecycle review) ---

test('C-1: cleanup with an empty --harness or --older-than is an error, not "no filter"', async () => {
  const { ctx, settings } = await sessionSetup();
  const stateBefore = await readFile(path.join(ctx.dir, 'state.json'), 'utf8');
  for (const bad of ['', ',', ' , ']) {
    for (const dryRun of [true, false]) {
      await assert.rejects(cleanup({ harness: bad, dryRun }, ctx), (e) => e instanceof UserError && /--harness/.test(e.message), JSON.stringify(bad));
    }
  }
  for (const dryRun of [true, false]) {
    await assert.rejects(cleanup({ olderThan: '', dryRun }, ctx), (e) => e instanceof UserError && /--older-than/.test(e.message));
  }
  assert.equal(await readFile(path.join(ctx.dir, 'state.json'), 'utf8'), stateBefore);
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['noncore-plugin@example'], true);
});

test('I-3/M-4: add never writes through a symlinked harness dir unless named, and never into an excluded root', async () => {
  const { symlink } = await import('node:fs/promises');
  const { home, sha, ctx } = await setup();
  const expected = path.join(storeDir(ctx.dir), sha, 'demo');
  // cursor → a non-work dir: only when named explicitly.
  await mkdir(path.join(home, 'elsewhere/cur'), { recursive: true });
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await symlink(path.join(home, 'elsewhere/cur'), path.join(home, '.cursor/skills'));
  await mkdir(ctx.dir, { recursive: true });
  await writeFile(path.join(ctx.dir, 'harnesses.json'), JSON.stringify({ harnesses: ['claude', 'cursor'] }));
  await writeFile(path.join(ctx.dir, 'config.json'), JSON.stringify({ excludedRoots: ['~/acme-work'] }));
  await assert.rejects(add('demo', { to: 'all' }, ctx), (e) => e instanceof UserError && /\.cursor\/skills/.test(e.message) && /--to cursor/.test(e.message));
  assert.ok(!(await exists(storeDir(ctx.dir))), 'nothing materialized');
  assert.ok(!(await exists(path.join(home, '.claude/skills/demo'))));
  await add('demo', { to: 'cursor' }, ctx);
  assert.equal(await readlink(path.join(home, 'elsewhere/cur/demo')), expected);

  // gemini → an excluded root, and kiro whose parent is under one: refused even when named.
  await mkdir(path.join(home, 'acme-work/client/skills'), { recursive: true });
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await symlink(path.join(home, 'acme-work/client/skills'), path.join(home, '.gemini/skills'));
  await symlink(path.join(home, 'acme-work/client'), path.join(home, '.kiro'));
  for (const [h, dir] of [['gemini', '.gemini/skills'], ['kiro', '.kiro/skills']]) {
    const msg = `${path.join(home, dir)} resolves under an excluded root (~/acme-work); not installing there`;
    await assert.rejects(add('demo', { to: h }, ctx), (e) => e instanceof UserError && e.message === msg, h);
  }
  assert.deepEqual(await readdir(path.join(home, 'acme-work/client/skills')), []);
  assert.deepEqual((await loadState(ctx.dir)).active[0].targets.map((t) => t.harness), ['cursor']);
});

test('add refuses a harness skills dir that is a broken symlink, in English', async () => {
  const { symlink } = await import('node:fs/promises');
  const { home, ctx } = await setup();
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await symlink(path.join(home, 'gone'), path.join(home, '.gemini/skills'));
  const msg = `${path.join(home, '.gemini/skills')} is a broken symlink; not installing there`;
  await assert.rejects(add('demo', { to: 'gemini' }, ctx), (e) => e instanceof UserError && e.message === msg);
});

test('without config nothing is excluded: add installs through a named symlinked dir under ~/acme-work', async () => {
  const { symlink } = await import('node:fs/promises');
  const { home, sha, ctx } = await setup();
  await mkdir(path.join(home, 'acme-work/client/skills'), { recursive: true });
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await symlink(path.join(home, 'acme-work/client/skills'), path.join(home, '.gemini/skills'));
  await add('demo', { to: 'gemini' }, ctx);
  assert.equal(await readlink(path.join(home, 'acme-work/client/skills/demo')), path.join(storeDir(ctx.dir), sha, 'demo'));
});

test('I-4: two parallel adds both land in state.json', async () => {
  const { api, ctx } = await setup();
  api.addSkill({ slug: 'other', files: [file('SKILL.md', '---\nname: other\n---\n# Other')] });
  await Promise.all([add('demo', { to: 'claude' }, ctx), add('other', { to: 'codex' }, ctx)]);
  assert.deepEqual(await slugs(ctx), ['demo', 'other']);
  assert.ok(!(await readdir(ctx.dir)).some((n) => n.endsWith('.lock') || n.endsWith('.tmp')), 'lock released');
});

test('I-4: parallel add and remove/cleanup keep every update', async () => {
  const { ctx } = await sessionSetup();
  await Promise.all([cleanup({ harness: 'gemini' }, ctx), remove('keep', {}, ctx)]);
  const state = await loadState(ctx.dir);
  assert.deepEqual(state.active.map((e) => e.slug).sort(), ['demo', 'noncore-plugin@example']);
  assert.deepEqual(state.active.find((e) => e.slug === 'demo').targets.map((t) => t.harness), ['claude']);
});

test('I-4: the state lock times out with a UserError while held and is taken over once stale', async () => {
  const { utimes } = await import('node:fs/promises');
  const { withStateLock } = await import('../../cli/state.mjs');
  const { ctx } = await setup();
  const lock = path.join(ctx.dir, 'state.lock');
  await mkdir(ctx.dir, { recursive: true });
  await writeFile(lock, '999999\n');
  await assert.rejects(withStateLock(ctx.dir, async () => 'ran', { retries: 3, delayMs: 5 }), (e) => e instanceof UserError && /state\.lock/.test(e.message));
  assert.ok(await exists(lock), 'a live lock is not broken');
  const old = new Date(Date.now() - 60e3);
  await utimes(lock, old, old);
  assert.equal(await withStateLock(ctx.dir, async () => 'ran', { retries: 3, delayMs: 5 }), 'ran');
  assert.ok(!(await exists(lock)), 'released');
});

test('M-5: a corrupt harnesses.json breaks only `all`; add, remove and cleanup with explicit ids still work', async () => {
  const { home, ctx } = await setup();
  await mkdir(ctx.dir, { recursive: true });
  await writeFile(path.join(ctx.dir, 'harnesses.json'), '{not json');
  await add('demo', {}, ctx);
  await add('demo', { to: 'gemini', session: true }, ctx);
  assert.ok(await exists(path.join(home, '.gemini/skills/demo')));
  await remove('demo', { from: 'codex' }, ctx);
  assert.ok(!(await exists(path.join(home, '.codex/skills/demo'))));
  assert.deepEqual(await cleanup({ harness: 'claude', dryRun: true }, ctx), []);
  for (const run of [() => add('demo', { to: 'all' }, ctx), () => remove('demo', { from: 'claude,all' }, ctx), () => cleanup({ harness: 'all' }, ctx)]) {
    await assert.rejects(run(), (e) => e instanceof UserError && /harnesses\.json is corrupt; run: headjack harness detect/.test(e.message));
  }
});

test('M-3: --older-than 0m takes every session entry; one without addedAt is skipped by --older-than only', async () => {
  const { ctx } = await sessionSetup();
  const state = await loadState(ctx.dir);
  delete state.active.find((e) => e.slug === 'demo').addedAt;
  await saveState(ctx.dir, state);
  assert.deepEqual((await cleanup({ olderThan: '0m', dryRun: true }, ctx)).map((r) => r.slug), ['noncore-plugin@example']);
  assert.deepEqual((await cleanup({ olderThan: '0m' }, ctx)).map((r) => r.slug), ['noncore-plugin@example']);
  assert.deepEqual(await slugs(ctx), ['demo', 'keep']);
  assert.deepEqual((await cleanup({}, ctx)).map((r) => r.slug), ['demo'], 'without --older-than it still goes');
  assert.deepEqual(await slugs(ctx), ['keep']);
});

test('M-6: cleanup goes on past a failing remove and reports it', async () => {
  const { home, ctx, settings } = await sessionSetup();
  const state = await loadState(ctx.dir);
  state.active.sort((a, b) => (a.kind === 'plugin' ? -1 : 0) - (b.kind === 'plugin' ? -1 : 0)); // the failing plugin first
  await saveState(ctx.dir, state);
  await writeFile(settings, '{broken');
  const done = await cleanup({}, ctx);
  const plugin = done.find((r) => r.slug === 'noncore-plugin@example');
  assert.match(plugin.error, /is not valid JSON/);
  assert.equal(done.find((r) => r.slug === 'demo').error, undefined);
  assert.ok(!(await exists(path.join(home, '.claude/skills/demo'))), 'the next entry was still removed');
  assert.deepEqual(await slugs(ctx), ['keep', 'noncore-plugin@example'], 'the failed entry stays in state for a retry');
});

// --- Capability contract: managed result, install events, remove --if-session ---

async function pluginSetup() {
  const s = await setup();
  s.api.addSkill({ slug: 'p@m', kind: 'plugin' });
  s.api.addSkill({ slug: 'p@m:skill', plugin_slug: 'p@m' });
  s.settings = path.join(s.home, '.claude', 'settings.json');
  return s;
}
const enabledIn = async (settings) => JSON.parse(await readFile(settings, 'utf8')).enabledPlugins;

test('add of a skill resolves { managed: true, kind: "skill" } and posts one install event', async () => {
  const { api, ctx } = await setup();
  assert.deepEqual(await add('demo', { to: 'claude' }, ctx), { managed: true, kind: 'skill' });
  assert.deepEqual(api.events, [{ slug: 'demo', kind: 'skill', source: 'manual' }]);
  await add('demo', { to: 'claude', source: 'plan' }, ctx);
  assert.deepEqual(api.events[1], { slug: 'demo', kind: 'skill', source: 'plan' });
});

test('add of a plugin skill whose plugin the user already enabled resolves managed: false and posts nothing', async () => {
  const { api, ctx, settings } = await pluginSetup();
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ enabledPlugins: { 'p@m': true } }));
  const r = await add('p@m:skill', {}, ctx);
  assert.equal(r.managed, false);
  assert.deepEqual(api.events, []);
});

test('add of a fresh plugin skill posts the requested slug with the vault row kind; the plugin row is kind plugin', async () => {
  const { api, ctx } = await pluginSetup();
  assert.deepEqual(await add('p@m:skill', {}, ctx), { managed: true, kind: 'skill' });
  assert.deepEqual(api.events, [{ slug: 'p@m:skill', kind: 'skill', source: 'manual' }]);
  assert.deepEqual(await add('p@m', {}, ctx), { managed: true, kind: 'plugin' });
  assert.deepEqual(api.events[1], { slug: 'p@m', kind: 'plugin', source: 'manual' });
});

test('add still resolves when installEvent rejects', async () => {
  const { api, ctx } = await setup();
  api.failInstallEvent = new Error('boom');
  assert.deepEqual(await add('demo', { to: 'claude' }, ctx), { managed: true, kind: 'skill' });
  assert.equal(api.events.length, 1);
});

test('remove --if-session removes a session entry, keeps a permanent one with a reason, and ignores a missing one', async () => {
  const { home, api, ctx } = await setup();
  api.addSkill({ slug: 'keep', files: [file('SKILL.md', '---\nname: keep\n---\n# Keep')] });
  await add('demo', { to: 'claude', session: true }, ctx);
  await add('keep', { to: 'claude' }, ctx);
  await remove('demo', { ifSession: true }, ctx);
  assert.ok(!(await exists(path.join(home, '.claude/skills/demo'))));
  await remove('keep', { ifSession: true }, ctx);
  assert.ok((await lstat(path.join(home, '.claude/skills/keep'))).isSymbolicLink());
  assert.deepEqual(await slugs(ctx), ['keep']);
  assert.match(ctx.log.text(), /keep: permanent install, not removing it/);
  await remove('missing', { ifSession: true }, ctx);
  assert.match(ctx.log.text(), /missing: not active, nothing to remove/);
});

test('remove p@m:skill --if-session acts on the p@m plugin entry only while it is a session entry', async () => {
  const { ctx, settings } = await pluginSetup();
  await add('p@m:skill', { session: true }, ctx);
  await remove('p@m:skill', { ifSession: true }, ctx);
  assert.equal((await enabledIn(settings))['p@m'], false);
  assert.deepEqual(await slugs(ctx), []);

  await add('p@m:skill', {}, ctx);
  await remove('p@m:skill', { ifSession: true }, ctx);
  assert.equal((await enabledIn(settings))['p@m'], true);
  assert.deepEqual(await slugs(ctx), ['p@m']);
});

test('plain remove p@m:skill keeps the "is not active" UserError', async () => {
  const { ctx } = await pluginSetup();
  await add('p@m:skill', { session: true }, ctx);
  await assert.rejects(remove('p@m:skill', {}, ctx), (e) => e instanceof UserError && /is not active/.test(e.message));
});

test('resolveEntry matches exactly, then by the plugin key of <plugin>@<marketplace>:<skill>', () => {
  const state = { active: [{ slug: 'demo', kind: 'skill', targets: [] }, { slug: 'p@m', kind: 'plugin', targets: [] }] };
  assert.equal(resolveEntry(state, 'demo'), state.active[0]);
  assert.equal(resolveEntry(state, 'p@m'), state.active[1]);
  assert.equal(resolveEntry(state, 'p@m:skill'), state.active[1]);
  assert.equal(resolveEntry(state, 'q@m:skill'), null);
  assert.equal(resolveEntry(state, 'demo:skill'), null);
  assert.equal(resolveEntry(state, 'nope'), null);
});

// The state dir can be reached through a symlink (~/.headjack -> a legacy state directory): links created through one spelling
// must be recognised through the other.
async function aliasedSetup() {
  const { symlink } = await import('node:fs/promises');
  const s = await setup();
  const real = path.join(s.home, 'real-state');
  const alias = path.join(s.home, 'alias-state');
  await mkdir(real);
  await symlink(real, alias);
  const via = (dir) => ({ ...s.ctx, dir, log: captureLog() });
  return { ...s, real, alias, via };
}

for (const [from, to] of [['alias', 'real'], ['real', 'alias']]) {
  test(`state dir symlink: linked via the ${from} spelling, verify and remove through the ${to} one`, async () => {
    const t = await aliasedSetup();
    await add('demo', {}, t.via(t[from]));
    const link = path.join(t.home, '.claude', 'skills', 'demo');
    assert.ok((await readlink(link)).startsWith(t[from] + path.sep), 'the link keeps the spelling it was created through');
    assert.deepEqual(await verify(t.via(t[to])), []);
    const ctx = t.via(t[to]);
    await remove('demo', {}, ctx);
    assert.doesNotMatch(ctx.log.text(), /no longer an headjack symlink/);
    for (const h of ['claude', 'codex', 'grok']) assert.ok(!(await exists(path.join(t.home, `.${h}`, 'skills', 'demo'))), h);
    assert.deepEqual((await loadState(t[to])).active, []);
  });

  test(`state dir symlink: cleanup via the ${to} spelling removes session links made via the ${from} one`, async () => {
    const t = await aliasedSetup();
    await add('demo', { session: true }, t.via(t[from]));
    const rows = await cleanup({}, t.via(t[to]));
    assert.deepEqual(rows.map((r) => r.error), [undefined]);
    assert.ok(!(await exists(path.join(t.home, '.claude', 'skills', 'demo'))));
    assert.deepEqual((await loadState(t[to])).active, []);
  });
}

test('state dir symlink: re-adding through the other spelling treats the existing link as managed', async () => {
  const t = await aliasedSetup();
  await add('demo', {}, t.via(t.alias));
  await add('demo', {}, t.via(t.real));
  assert.deepEqual(await verify(t.via(t.real)), []);
});

test('a link into a different store stays unmanaged: add and remove refuse it, verify reports it', async () => {
  const { symlink } = await import('node:fs/promises');
  const t = await aliasedSetup();
  await add('demo', {}, t.via(t.alias));
  const link = path.join(t.home, '.claude', 'skills', 'demo');
  const foreign = path.join(t.home, 'other-state', 'store', 'abc', 'demo');
  await mkdir(foreign, { recursive: true });
  const { rm } = await import('node:fs/promises');
  await rm(link);
  await symlink(foreign, link);

  const ctx = t.via(t.real);
  assert.equal((await verify(ctx)).length, 1);
  await remove('demo', {}, ctx);
  assert.match(ctx.log.text(), /is no longer an headjack symlink/);
  assert.equal(await readlink(link), foreign, 'the foreign link is left alone');
  await assert.rejects(add('demo', {}, t.via(t.real)), (e) => e instanceof UserError && /headjack does not manage it/.test(e.message));
});

test('a dangling link through the other spelling of the state dir is still managed', async () => {
  const { rm } = await import('node:fs/promises');
  const t = await aliasedSetup();
  await add('demo', {}, t.via(t.alias));
  await rm(path.join(t.real, 'store'), { recursive: true });
  const ctx = t.via(t.real);
  await remove('demo', {}, ctx);
  assert.doesNotMatch(ctx.log.text(), /no longer an headjack symlink/);
  assert.ok(!(await exists(path.join(t.home, '.claude', 'skills', 'demo'))));
});

// A looping link (loop -> loop, a -> b -> a) cannot be resolved (ELOOP); it was never ours, so it is simply unmanaged.
test('a looping link is reported unmanaged, and remove, cleanup and verify neither throw nor delete it', async () => {
  const { symlink, rm } = await import('node:fs/promises');
  const { linkStatus } = await import('../../cli/install.mjs');
  const { ctx, home } = await setup();
  const store = storeDir(ctx.dir);
  const selfLoop = path.join(home, 'loop');
  await symlink('loop', selfLoop);
  assert.deepEqual(await linkStatus(selfLoop, store), { exists: true, managed: false });
  const a = path.join(home, 'a');
  await symlink('b', a);
  await symlink('a', path.join(home, 'b'));
  assert.deepEqual(await linkStatus(a, store), { exists: true, managed: false });

  await add('demo', {}, ctx);
  await add('demo', { session: true }, ctx);
  for (const h of ['claude', 'codex', 'grok']) {
    const link = path.join(home, `.${h}`, 'skills', 'demo');
    await rm(link);
    await symlink('demo', link); // loops on itself
  }
  assert.equal((await verify(ctx)).length, 3, 'verify reports each looped target as not pointing at the store');
  await cleanup({}, ctx);
  await remove('demo', {}, ctx);
  for (const h of ['claude', 'codex', 'grok']) assert.equal(await readlink(path.join(home, `.${h}`, 'skills', 'demo')), 'demo', `${h} loop link kept`);
  assert.match(ctx.log.text(), /is no longer an headjack symlink/);
});

test('a successful add appends one add event with the session, slug and source, and nothing else', async () => {
  const { ctx } = await setup();
  ctx.env = { CLAUDE_CODE_SESSION_ID: 'sess-1234' };
  await add('demo', { source: 'suggest' }, ctx);
  const events = await readEvents(ctx.dir);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'session', 'slug', 'source', 'type']);
  assert.equal(events[0].type, 'add');
  assert.equal(events[0].session, 'sess-1234');
  assert.equal(events[0].slug, 'demo');
  assert.equal(events[0].source, 'suggest');
  assert.ok(Number.isFinite(Date.parse(events[0].at)));
});

test('the add event has a null session when CLAUDE_CODE_SESSION_ID is missing or not a valid id, and source defaults to manual', async () => {
  for (const env of [{}, { CLAUDE_CODE_SESSION_ID: '../../etc' }, { CLAUDE_CODE_SESSION_ID: 'x'.repeat(65) }, { CLAUDE_CODE_SESSION_ID: '' }]) {
    const { ctx } = await setup();
    ctx.env = env;
    await add('demo', {}, ctx);
    const [event] = await readEvents(ctx.dir);
    assert.equal(event.session, null, JSON.stringify(env));
    assert.equal(event.source, 'manual');
  }
});

test('a failed add writes no add event', async () => {
  const { ctx } = await setup();
  await assert.rejects(add('nope', {}, ctx));
  ctx.api.failDownload('demo', new Error('network down'));
  await assert.rejects(add('demo', {}, ctx));
  assert.deepEqual(await readEvents(ctx.dir), []);
});

test('a logging failure never fails the add', async () => {
  const { ctx } = await setup();
  // <dir>/suggest is a file, so the log cannot be created.
  await mkdir(ctx.dir, { recursive: true });
  await writeFile(path.join(ctx.dir, 'suggest'), 'not a directory');
  await add('demo', { source: 'suggest' }, ctx);
  assert.ok(await exists(path.join(ctx.home, '.claude', 'skills', 'demo')));
});
