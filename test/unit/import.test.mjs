import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { symlink, mkdir, writeFile, readFile, lstat, access, readdir, readlink, realpath } from 'node:fs/promises';
import { planImport, runImport, trim, restore, GRANDFATHERED } from '../../cli/import.mjs';
import { hashFiles, hashDir } from '../../lib/hash.mjs';
import { unpack } from '../../lib/tar.mjs';
import { UserError } from '../../lib/errors.mjs';
import { verify } from '../../cli/install.mjs';
import { fakeApi } from '../fake-api.mjs';
import { tempDir, makeDir, scriptedPrompt, captureLog } from '../helpers.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const skillMd = (name) => `---\nname: ${name}\ndescription: ${name} description\n---\n# Use\nText.\n`;

// Invented plugin keys: tests never name the owner's plugins.
const CORE = ['acme-core@acme-market'];

// `core` writes corePlugins into config.json and enables those plugins in settings.json (so none is stale).
async function fixtureHome({ core } = {}) {
  const home = await tempDir('sv-home-');
  await makeDir({
    '.agents/skills/remotion-render/SKILL.md': skillMd('remotion-render'),
    '.agents/skills/humanizer/SKILL.md': skillMd('humanizer'),
    '.agents/skills/leaky/SKILL.md': `${skillMd('leaky')}\nkey ${'AK' + 'IA'}${'A'.repeat(16)}\n`,
    '.agents/.skill-lock.json': JSON.stringify({ version: 3, skills: { 'remotion-render': { source: 'remotion-dev/skills', sourceType: 'github', sourceUrl: 'https://github.com/remotion-dev/skills.git', skillPath: 'skills/remotion-render/SKILL.md' } } }),
    '.claude/skills/brand-naming/SKILL.md': skillMd('brand-naming'),
    'acme-work/repo/.claude/skills/client-skill/SKILL.md': skillMd('client-skill'),
    'plugins/sp/.claude-plugin/plugin.json': JSON.stringify({ name: 'superpowers', description: 'Core skills library' }),
    'plugins/sp/skills/brainstorming/SKILL.md': skillMd('brainstorming'),
    'plugins/sp/skills/writing-plans/SKILL.md': skillMd('writing-plans'),
    '.claude/settings.json': JSON.stringify({ model: 'opus', enabledPlugins: {
      ...Object.fromEntries((core ?? []).map((k) => [k, true])), 'superpowers@superpowers-marketplace': true, 'noncore-plugin@example': true,
    } }),
  }, home);
  await mkdir(path.join(home, '.codex', 'skills'), { recursive: true });
  await mkdir(path.join(home, '.grok', 'skills'), { recursive: true });
  for (const h of ['.claude', '.codex']) await symlink('../../.agents/skills/remotion-render', path.join(home, h, 'skills', 'remotion-render'));
  await symlink('../../.agents/skills/humanizer', path.join(home, '.grok', 'skills', 'humanizer'));
  await symlink(path.join(home, 'acme-work/repo/.claude/skills/client-skill'), path.join(home, '.codex', 'skills', 'client-skill'));
  await symlink('/nonexistent/broken', path.join(home, '.codex', 'skills', 'broken'));
  await makeDir({ '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'superpowers@superpowers-marketplace': [{ scope: 'user', installPath: path.join(home, 'plugins/sp'), version: '6.4.1', gitCommitSha: 'c'.repeat(40) }] } }) }, home);
  const finderDir = await makeDir({ 'SKILL.md': skillMd('skill-finder') });
  const api = fakeApi();
  await makeDir({ '.headjack/config.json': JSON.stringify({ excludedRoots: ['~/acme-work'], ...(core ? { corePlugins: core } : {}) }) }, home);
  return { home, api, ctx: { api, home, env: {}, dir: path.join(home, '.headjack'), log: captureLog(), prompt: scriptedPrompt([]), finderDir } };
}

const bySlug = (plan) => Object.fromEntries(plan.entries.map((e) => [e.slug, e]));

test('plan groups skills, dedupes by realpath and flags excluded roots', async () => {
  const { ctx } = await fixtureHome();
  const plan = await planImport(ctx);
  const e = bySlug(plan);
  assert.equal(e['remotion-render'].group, 'lock');
  assert.deepEqual(e['remotion-render'].source, { kind: 'github', url: 'https://github.com/remotion-dev/skills.git' });
  assert.equal(e['remotion-render'].source_path, 'skills/remotion-render');
  assert.equal(e.humanizer.group, 'local');
  assert.equal(e['brand-naming'].group, 'local');
  assert.equal(e['client-skill'].group, 'work');
  assert.equal(e['client-skill'].upload, false);
  assert.equal(e['remotion-render'].upload, null);
  assert.equal(e['superpowers@superpowers-marketplace'].group, 'plugin');
  assert.equal(e['superpowers@superpowers-marketplace:brainstorming'].plugin_slug, 'superpowers@superpowers-marketplace');
  assert.equal(plan.entries.filter((x) => x.slug === 'remotion-render').length, 1);
  assert.ok(!e.broken);
  assert.deepEqual(JSON.parse(await readFile(path.join(ctx.dir, 'import-plan.json'), 'utf8')).entries.length, plan.entries.length);
});

test('import refuses unconfirmed entries unless interactive', async () => {
  const { ctx } = await fixtureHome();
  await planImport(ctx);
  await assert.rejects(runImport({}, ctx), (e) => e instanceof UserError && /unconfirmed entries/.test(e.message));
});

test('import publishes grandfathered skills, plugin metadata, blocks secrets', async () => {
  const { ctx, api } = await fixtureHome();
  await planImport(ctx);
  // pending order: humanizer, leaky, remotion-render (~/.agents/skills), brand-naming (~/.claude/skills)
  const plan = JSON.parse(await readFile(path.join(ctx.dir, 'import-plan.json'), 'utf8'));
  for (const entry of plan.entries) if (entry.upload === null) entry.upload = entry.slug !== 'brand-naming';
  await writeFile(path.join(ctx.dir, 'import-plan.json'), JSON.stringify(plan));
  const report = await runImport({}, ctx);
  assert.deepEqual(report.published.sort(), ['humanizer', 'remotion-render', 'superpowers@superpowers-marketplace', 'superpowers@superpowers-marketplace:brainstorming', 'superpowers@superpowers-marketplace:writing-plans']);
  assert.deepEqual(report.blocked.map((b) => b.slug), ['leaky']);
  assert.ok(report.skipped.includes('brand-naming') && report.skipped.includes('client-skill'));
  const rr = api.published.find((p) => p.manifest.slug === 'remotion-render');
  assert.equal(rr.manifest.review_notes, GRANDFATHERED);
  assert.equal(rr.manifest.commit_sha, null);
  assert.equal(hashFiles(unpack(rr.tarball)), rr.manifest.sha256);
  const plugin = api.published.find((p) => p.manifest.slug === 'superpowers@superpowers-marketplace');
  assert.equal(plugin.manifest.kind, 'plugin');
  assert.equal(plugin.tarball, undefined);
  assert.equal(plugin.manifest.commit_sha, 'c'.repeat(40));
  const ps = api.published.find((p) => p.manifest.slug.endsWith(':brainstorming'));
  assert.equal(ps.manifest.plugin_slug, 'superpowers@superpowers-marketplace');
  assert.equal(ps.tarball, undefined);
});

test('grandfathered notes keep the exact prefix', () => {
  assert.ok(GRANDFATHERED.startsWith('grandfathered:'));
  assert.equal(GRANDFATHERED, 'grandfathered: installed before the vault, not reviewed');
});

test('import --interactive uses [y/N]', async () => {
  const { ctx, api } = await fixtureHome();
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 's', 'n', 'n', 'n']); // last one: the superpowers plugin
  await runImport({ interactive: true }, ctx);
  assert.equal(ctx.prompt.asked.length, 5);
  for (const q of ctx.prompt.asked) assert.match(q, /^Upload .*\? \[y\/N\] $/);
  // 'y' uploads; 's' (the old Spanish yes) is a no.
  assert.equal(api.published.filter((p) => !p.manifest.slug.includes('superpowers')).length, 1);
});

test('interactive import asks for each pending entry', async () => {
  const { ctx, api } = await fixtureHome();
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'n', 'n', 'n']); // last one: the superpowers plugin
  await runImport({ interactive: true }, ctx);
  assert.equal(ctx.prompt.remaining.length, 0);
  assert.equal(api.published.filter((p) => !p.manifest.slug.includes('superpowers')).length, 1);
});

test('re-running import is idempotent', async () => {
  const { ctx, api } = await fixtureHome();
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'y', 'y']); // last one: the superpowers plugin
  await runImport({ interactive: true }, ctx);
  const first = api.published.length;
  for (const p of api.published) api.conflicts.add(p.manifest.slug);
  const again = await runImport({}, ctx);
  assert.equal(api.published.length, first);
  assert.equal(again.published.length, 0);
  assert.deepEqual(again.failed, []);
  assert.ok(again.existing.includes('remotion-render'));
});

test('trim backs up, removes only imported skills, disables non-core plugins, installs skill-finder; restore undoes it', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']); // last one: the superpowers plugin
  await runImport({ interactive: true }, ctx);
  const res = await trim({}, ctx);
  assert.deepEqual(res.removed.sort(), [
    path.join(home, '.claude/skills/remotion-render'),
    path.join(home, '.codex/skills/remotion-render'),
    path.join(home, '.grok/skills/humanizer'),
  ].sort());
  assert.ok(await exists(path.join(home, '.claude/skills/brand-naming')), 'not imported → kept');
  assert.ok(await exists(path.join(home, '.agents/skills/remotion-render/SKILL.md')), '~/.agents untouched');
  assert.ok((await lstat(path.join(home, '.codex/skills/client-skill'))).isSymbolicLink(), 'work skill untouched');
  const settings = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(res.plugins, 'trimmed');
  assert.equal(settings.enabledPlugins['acme-core@acme-market'], true, 'configured core stays');
  assert.equal(settings.enabledPlugins['noncore-plugin@example'], false);
  assert.equal(settings.enabledPlugins['superpowers@superpowers-marketplace'], false, 'not core');
  assert.equal(settings.model, 'opus');
  for (const h of ['claude', 'codex', 'grok']) assert.ok((await lstat(path.join(home, `.${h}/skills/skill-finder`))).isSymbolicLink(), h);

  const out = await restore(res.backup, ctx);
  assert.ok(out.settings);
  assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink());
  assert.ok(await exists(path.join(home, '.grok/skills/humanizer/SKILL.md')));
  assert.equal(JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')).enabledPlugins['noncore-plugin@example'], true);
  assert.ok(await exists(path.join(home, '.claude/settings.json.pre-restore')));
});

test('trim does not delete a same-named skill whose realpath differs from the imported one', async () => {
  const { home, ctx } = await fixtureHome();
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']); // last one: the superpowers plugin
  await runImport({ interactive: true }, ctx);
  const { rm } = await import('node:fs/promises');
  const other = path.join(home, '.codex/skills/remotion-render');
  await rm(other);
  await makeDir({ 'SKILL.md': 'a different local copy' }, other);
  const res = await trim({}, ctx);
  assert.ok(!res.removed.includes(other));
  assert.equal(await readFile(path.join(other, 'SKILL.md'), 'utf8'), 'a different local copy');
});

test('trim requires a prior import', async () => {
  const { ctx } = await fixtureHome();
  await assert.rejects(trim({}, ctx), /import-plan.json does not exist; run headjack import --dry-run and headjack import first/);
  assert.deepEqual(await readdir(ctx.dir), ['config.json'], 'nothing created besides the fixture config');
});

test('a plugin installed under a work path is planned as work and never published', async () => {
  const { home, ctx, api } = await fixtureHome();
  const workPlugin = path.join(home, 'acme-work/marketplace/client-tools');
  await makeDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'client-tools', description: 'Client tooling' }),
    'skills/client-helper/SKILL.md': skillMd('client-helper'),
  }, workPlugin);
  await writeFile(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'superpowers@superpowers-marketplace': [{ scope: 'user', installPath: path.join(home, 'plugins/sp'), version: '6.4.1', gitCommitSha: 'c'.repeat(40) }],
    'acme-tools@acme-local': [{ scope: 'user', installPath: workPlugin, version: '1.0.0' }],
  } }));
  const e = bySlug(await planImport(ctx));
  assert.equal(e['acme-tools@acme-local'].group, 'work');
  assert.equal(e['acme-tools@acme-local'].upload, false);
  assert.equal(e['acme-tools@acme-local:client-helper'].group, 'work');
  assert.equal(e['acme-tools@acme-local:client-helper'].upload, false);
  assert.equal(e['superpowers@superpowers-marketplace'].group, 'plugin');
  ctx.prompt = scriptedPrompt(['n', 'n', 'n', 'n', 'n']); // last one: the superpowers plugin
  const report = await runImport({ interactive: true }, ctx);
  assert.ok(!api.published.some((p) => p.manifest.slug.startsWith('acme-tools')));
  assert.ok(report.skipped.includes('acme-tools@acme-local') && report.skipped.includes('acme-tools@acme-local:client-helper'));
});

// --- Fix round 1 ---

const planFile = (ctx) => path.join(ctx.dir, 'import-plan.json');
async function editPlan(ctx, fn) {
  const plan = JSON.parse(await readFile(planFile(ctx), 'utf8'));
  for (const entry of plan.entries) fn(entry);
  await writeFile(planFile(ctx), JSON.stringify(plan));
}
async function addWorkPlugin(home, settingsPlugins = null) {
  const workPlugin = path.join(home, 'acme-work/marketplace/client-tools');
  await makeDir({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'client-tools', description: 'Client tooling' }),
    'skills/client-helper/SKILL.md': skillMd('client-helper'),
  }, workPlugin);
  await writeFile(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'superpowers@superpowers-marketplace': [{ scope: 'user', installPath: path.join(home, 'plugins/sp'), version: '6.4.1', gitCommitSha: 'c'.repeat(40) }],
    'acme-tools@acme-local': [{ scope: 'user', installPath: workPlugin, version: '1.0.0' }],
  } }));
  if (settingsPlugins) await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', enabledPlugins: settingsPlugins }));
}

test('import never publishes work entries even when the plan says upload: true', async () => {
  const { home, ctx, api } = await fixtureHome();
  await addWorkPlugin(home);
  await planImport(ctx);
  await editPlan(ctx, (entry) => {
    if (entry.upload === null) entry.upload = false;
    if (entry.slug === 'client-skill') { entry.upload = true; entry.group = 'local'; } // realpath still under ~/acme-work
    if (entry.slug.startsWith('acme-tools@')) entry.upload = true;
  });
  const report = await runImport({}, ctx);
  const work = ['client-skill', 'acme-tools@acme-local', 'acme-tools@acme-local:client-helper'];
  assert.deepEqual(api.published.map((p) => p.manifest.slug).filter((s) => work.includes(s)), []);
  for (const slug of work) assert.ok(report.skipped.includes(slug), slug);
  const saved = bySlug(JSON.parse(await readFile(planFile(ctx), 'utf8')));
  for (const slug of work) {
    assert.equal(saved[slug].note, 'under an excluded root: not uploaded', slug);
    assert.ok(!saved[slug].imported, slug);
  }
});

test('import rejects a non-boolean upload value naming the slug', async () => {
  const { ctx, api } = await fixtureHome();
  await planImport(ctx);
  await editPlan(ctx, (entry) => { entry.upload = entry.slug === 'humanizer' ? 'false' : false; });
  await assert.rejects(runImport({}, ctx), (e) => e instanceof UserError && /humanizer/.test(e.message));
  assert.equal(api.published.length, 0);
});

test('trim does not delete through a harness skills dir that is a symlink', async () => {
  const { home, ctx } = await fixtureHome();
  const { rm } = await import('node:fs/promises');
  await rm(path.join(home, '.codex/skills'), { recursive: true });
  await symlink('../.agents/skills', path.join(home, '.codex/skills'));
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']); // last one: the superpowers plugin
  await runImport({ interactive: true }, ctx);
  const res = await trim({}, ctx);
  assert.ok(!res.removed.some((p) => p.startsWith(path.join(home, '.codex'))), res.removed.join(','));
  assert.ok(await exists(path.join(home, '.agents/skills/remotion-render/SKILL.md')));
  assert.ok(await exists(path.join(home, '.agents/skills/humanizer/SKILL.md')));
  assert.ok(res.removed.includes(path.join(home, '.claude/skills/remotion-render')), 'non-symlinked harness still trimmed');
});

test('plan marks a duplicated plugin-skill slug as not uploaded', async () => {
  const { home, ctx } = await fixtureHome();
  await makeDir({ 'plugins/sp/skills/extra/brainstorming/SKILL.md': skillMd('brainstorming') }, home);
  const plan = await planImport(ctx);
  const dups = plan.entries.filter((x) => x.slug === 'superpowers@superpowers-marketplace:brainstorming');
  assert.equal(dups.length, 2);
  assert.equal(dups[0].upload, null, 'follows its plugin');
  assert.equal(dups[1].upload, false);
  assert.match(dups[1].note, /duplicate slug/);
});

test('trim reports and logs each work plugin it disables', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  await addWorkPlugin(home, { 'acme-core@acme-market': true, 'superpowers@superpowers-marketplace': true, 'acme-tools@acme-local': true, 'noncore-plugin@example': true });
  await planImport(ctx);
  const res = await trim({}, ctx);
  assert.deepEqual(res.disabledWork, ['acme-tools@acme-local']);
  assert.ok(res.disabled.includes('acme-tools@acme-local') && res.disabled.includes('noncore-plugin@example'));
  assert.ok(ctx.log.lines.includes('warning: work plugin disabled: acme-tools@acme-local (enable it in the repo\'s .claude/settings.json)'), ctx.log.text());
});

// A plugin with two skills, installed as acme-core@acme-market (core only when config.json says so).
async function addCorePlugin(home) {
  await makeDir({
    'plugins/core/.claude-plugin/plugin.json': JSON.stringify({ name: 'acme-core', description: 'core' }),
    'plugins/core/skills/one/SKILL.md': skillMd('one'),
    'plugins/core/skills/two/SKILL.md': skillMd('two'),
    '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: {
      'acme-core@acme-market': [{ scope: 'user', installPath: path.join(home, 'plugins/core'), version: '1.0.0', gitCommitSha: 'd'.repeat(40) }],
    } }),
  }, home);
}

test('trim with corePlugins keeps them; --keep adds; naming a claude-mem replaces the configured one', async () => {
  const { home, ctx } = await fixtureHome({ core: ['acme-core@acme-market', 'claude-mem@acme-market'] });
  await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: {
    'acme-core@acme-market': true, 'claude-mem@acme-market': true, 'claude-mem@other-market': true,
    'extra-plugin@example': true, 'noncore-plugin@example': true,
  } }));
  await planImport(ctx);
  const res = await trim({ keep: 'claude-mem@other-market,extra-plugin@example' }, ctx);
  assert.equal(res.plugins, 'trimmed');
  const on = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')).enabledPlugins;
  assert.equal(on['acme-core@acme-market'], true, 'configured core stays');
  assert.equal(on['extra-plugin@example'], true, '--keep adds to the core');
  assert.equal(on['claude-mem@other-market'], true, 'the named claude-mem stays');
  assert.equal(on['claude-mem@acme-market'], false, 'spec §8.1: only one claude-mem stays');
  assert.equal(on['noncore-plugin@example'], false);
});

test('the configured core keeps its plugins and drops a second claude-mem and non-core ones', async () => {
  const core = ['acme-core@acme-market', 'acme-tools@acme-market', 'claude-mem@acme-market'];
  const { home, ctx } = await fixtureHome({ core });
  const others = ['superpowers@superpowers-marketplace', 'claude-mem@other-market', 'noncore-plugin@example'];
  await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: Object.fromEntries([...core, ...others].map((k) => [k, true])) }));
  await planImport(ctx);
  await trim({}, ctx);
  const on = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')).enabledPlugins;
  for (const k of core) assert.equal(on[k], true, `${k} is core`);
  assert.equal(on['superpowers@superpowers-marketplace'], false, 'not core');
  assert.equal(on['claude-mem@other-market'], false, 'spec §8.1: only one claude-mem stays');
  assert.equal(on['noncore-plugin@example'], false);
});

test('trim without corePlugins and without --keep leaves plugins untouched', async () => {
  const { home, ctx } = await fixtureHome();
  const settingsFile = path.join(home, '.claude/settings.json');
  const before = await readFile(settingsFile, 'utf8');
  await planImport(ctx);
  const dry = await trim({ dryRun: true }, ctx);
  assert.equal(dry.plugins, 'untouched');
  assert.deepEqual(dry.disabled, []);
  const res = await trim({}, ctx);
  assert.equal(res.plugins, 'untouched');
  assert.deepEqual(res.disabled, []);
  assert.equal(await readFile(settingsFile, 'utf8'), before, 'enabledPlugins unchanged');
  const record = JSON.parse(await readFile(path.join(res.backup, 'backup.json'), 'utf8'));
  assert.equal(record.settings, null, 'restore must not revert later plugin changes');
});

test('trim without corePlugins but with --keep trims to exactly --keep', async () => {
  const { home, ctx } = await fixtureHome();
  await planImport(ctx);
  const res = await trim({ keep: 'noncore-plugin@example' }, ctx);
  assert.equal(res.plugins, 'trimmed');
  assert.deepEqual(res.disabled, ['superpowers@superpowers-marketplace']);
  const on = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')).enabledPlugins;
  assert.deepEqual(on, { 'superpowers@superpowers-marketplace': false, 'noncore-plugin@example': true });
  const record = JSON.parse(await readFile(path.join(res.backup, 'backup.json'), 'utf8'));
  assert.equal(record.settings, path.join(home, '.claude/settings.json'));
});

test('trim stops on a stale core entry', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  const file = path.join(ctx.dir, 'config.json');
  await writeFile(file, JSON.stringify({ excludedRoots: ['~/acme-work'], corePlugins: ['acme-core@acme-market', 'gone@acme-market'] }));
  const settingsFile = path.join(home, '.claude/settings.json');
  const before = await readFile(settingsFile, 'utf8');
  await planImport(ctx);
  const message = `corePlugins entries match no installed plugin: gone@acme-market; fix ${file} before trimming`;
  for (const dryRun of [true, false]) {
    await assert.rejects(trim({ dryRun }, ctx), (e) => e instanceof UserError && e.message === message);
  }
  assert.equal(await readFile(settingsFile, 'utf8'), before, 'settings.json unchanged');
  assert.ok(!(await readdir(ctx.dir)).some((n) => n.startsWith('backup-')), 'no backup');
  assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink(), 'nothing removed');
});

test('an installed but disabled core plugin is not stale', async () => {
  const { home, ctx } = await fixtureHome();
  // acme-core is disabled in settings.json; superpowers is only in installed_plugins.json; neither is stale.
  await writeFile(path.join(ctx.dir, 'config.json'), JSON.stringify({ corePlugins: ['acme-core@acme-market', 'superpowers@superpowers-marketplace'] }));
  await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'acme-core@acme-market': false, 'noncore-plugin@example': true } }));
  await planImport(ctx);
  const res = await trim({}, ctx);
  assert.deepEqual(res.disabled, ['noncore-plugin@example']);
  const on = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')).enabledPlugins;
  assert.deepEqual(on, { 'acme-core@acme-market': false, 'noncore-plugin@example': false }, 'trim never enables a plugin');
});

test('planImport skips skills of configured core plugins', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  await addCorePlugin(home);
  const e = bySlug(await planImport(ctx));
  assert.equal(e['acme-core@acme-market'].upload, null, 'the plugin row is still asked once');
  for (const slug of ['acme-core@acme-market:one', 'acme-core@acme-market:two']) {
    assert.equal(e[slug].upload, false, slug);
    assert.equal(e[slug].note, 'core plugin: always loaded, its skills are not indexed');
  }
});

test('planImport without corePlugins skips no plugin', async () => {
  const { home, ctx } = await fixtureHome();
  await addCorePlugin(home);
  const e = bySlug(await planImport(ctx));
  for (const slug of ['acme-core@acme-market:one', 'acme-core@acme-market:two']) {
    assert.equal(e[slug].upload, null, `${slug} follows its plugin`);
    assert.equal(e[slug].note, undefined);
  }
});

test('a re-plan recomputes policy skips: a plugin removed from corePlugins is no longer skipped', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  await addCorePlugin(home);
  const first = bySlug(await planImport(ctx));
  assert.equal(first['acme-core@acme-market:one'].upload, false);
  await writeFile(path.join(ctx.dir, 'config.json'), JSON.stringify({}));
  delete ctx.localConfig;
  delete ctx.excludedRoots;
  const e = bySlug(await planImport(ctx));
  for (const slug of ['acme-core@acme-market:one', 'acme-core@acme-market:two']) {
    assert.equal(e[slug].upload, null, `${slug} follows its plugin again`);
    assert.equal(e[slug].note, undefined, `${slug} drops the core note`);
  }
});

test('a re-plan recomputes an excluded-root skip once the root is no longer excluded, and keeps user answers', async () => {
  const { home, ctx } = await fixtureHome();
  const humanizer = await realpath(path.join(home, '.agents/skills/humanizer'));
  const brand = await realpath(path.join(home, '.claude/skills/brand-naming'));
  await writeFile(path.join(ctx.dir, 'import-plan.json'), JSON.stringify({ entries: [
    { slug: 'humanizer', group: 'local', path: humanizer, upload: false, note: 'under an excluded root: not uploaded' },
    { slug: 'brand-naming', group: 'local', path: brand, upload: false, note: 'kept private by hand' },
  ] }));
  const e = bySlug(await planImport(ctx));
  assert.equal(e.humanizer.upload, null);
  assert.equal(e.humanizer.note, undefined);
  assert.equal(e['brand-naming'].upload, false, 'a user decision is carried');
  assert.equal(e['brand-naming'].note, 'kept private by hand');
});

test('a re-plan recomputes a former excluded-root entry planned without a note (group work)', async () => {
  const { home, ctx } = await fixtureHome();
  const humanizer = await realpath(path.join(home, '.agents/skills/humanizer'));
  await writeFile(path.join(ctx.dir, 'import-plan.json'), JSON.stringify({ entries: [
    { slug: 'humanizer', group: 'work', path: humanizer, upload: false },
  ] }));
  const e = bySlug(await planImport(ctx));
  assert.equal(e.humanizer.group, 'local');
  assert.equal(e.humanizer.upload, null, 'the root is no longer excluded, so the entry is asked again');
  assert.equal(e.humanizer.note, undefined);
});

test('plugin skills are indexed only for non-core plugins with more than one skill', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  const install = (dir) => [{ scope: 'user', installPath: path.join(home, dir), version: '1.0.0', gitCommitSha: 'd'.repeat(40) }];
  await makeDir({
    'plugins/core/.claude-plugin/plugin.json': JSON.stringify({ name: 'acme-core', description: 'core' }),
    'plugins/core/skills/one/SKILL.md': skillMd('one'),
    'plugins/core/skills/two/SKILL.md': skillMd('two'),
    'plugins/solo/.claude-plugin/plugin.json': JSON.stringify({ name: 'solo', description: 'one skill' }),
    'plugins/solo/skills/only/SKILL.md': skillMd('only'),
    'plugins/multi/.claude-plugin/plugin.json': JSON.stringify({ name: 'multi', description: 'several skills' }),
    'plugins/multi/skills/alpha/SKILL.md': skillMd('alpha'),
    'plugins/multi/skills/beta/SKILL.md': skillMd('beta'),
    '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: {
      'acme-core@acme-market': install('plugins/core'), 'solo@example': install('plugins/solo'), 'multi@example': install('plugins/multi'),
    } }),
  }, home);
  const e = bySlug(await planImport(ctx));
  for (const slug of ['acme-core@acme-market', 'solo@example', 'multi@example']) assert.equal(e[slug].upload, null, `${slug}: the plugin row is still asked once`);
  for (const slug of ['acme-core@acme-market:one', 'acme-core@acme-market:two']) {
    assert.equal(e[slug].upload, false, slug);
    assert.match(e[slug].note, /core plugin/);
  }
  assert.equal(e['solo@example:only'].upload, false);
  assert.match(e['solo@example:only'].note, /a single skill/);
  assert.equal(e['multi@example:alpha'].upload, null, 'non-core plugin with several skills follows its plugin');
  assert.equal(e['multi@example:beta'].upload, null);
});

test('a re-plan does not resurrect the imported flag of plugin skills the policy no longer indexes', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  await makeDir({
    'plugins/core/.claude-plugin/plugin.json': JSON.stringify({ name: 'acme-core', description: 'core' }),
    'plugins/core/skills/one/SKILL.md': skillMd('one'),
    'plugins/core/skills/two/SKILL.md': skillMd('two'),
    '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'acme-core@acme-market': [{ scope: 'user', installPath: path.join(home, 'plugins/core'), version: '1.0.0', gitCommitSha: 'd'.repeat(40) }] } }),
    '.headjack/import-plan.json': JSON.stringify({ entries: [{ slug: 'acme-core@acme-market:one', group: 'plugin-skill', plugin_slug: 'acme-core@acme-market', path: path.join(home, 'plugins/core/skills/one'), upload: null, imported: true }] }),
  }, home);
  const e = bySlug(await planImport(ctx));
  assert.equal(e['acme-core@acme-market:one'].upload, false);
  assert.equal(e['acme-core@acme-market:one'].imported, undefined);
});

test('plan refuses invalid slugs and skills that live in the plugin cache', async () => {
  const { home, ctx } = await fixtureHome();
  await makeDir({
    '.agents/skills/bad name/SKILL.md': skillMd('bad'),
    '.claude/plugins/cache/mk/p/1.0.0/skills/cached/SKILL.md': skillMd('cached'),
  }, home);
  await symlink(path.join(home, '.claude/plugins/cache/mk/p/1.0.0/skills/cached'), path.join(home, '.claude/skills/cached'));
  const e = bySlug(await planImport(ctx));
  assert.equal(e['bad name'].upload, false);
  assert.equal(e['bad name'].note, 'invalid slug');
  assert.equal(e.cached.upload, false);
  assert.equal(e.cached.note, 'belongs to a plugin (indexed through the plugin)');
});

test('a corrupt import-plan.json or backup.json is a UserError', async () => {
  const { ctx } = await fixtureHome();
  await mkdir(ctx.dir, { recursive: true });
  await writeFile(planFile(ctx), '{ not json');
  await assert.rejects(runImport({}, ctx), (e) => e instanceof UserError && /import-plan\.json is corrupt/.test(e.message));
  await assert.rejects(trim({}, ctx), (e) => e instanceof UserError && /import-plan\.json is corrupt/.test(e.message));
  const backup = path.join(ctx.dir, 'backup-x');
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, 'backup.json'), 'garbage');
  await assert.rejects(restore(backup, ctx), (e) => e instanceof UserError && /backup\.json is corrupt/.test(e.message));
});

// --- Final fix wave ---

const standaloneOff = (entry) => { if (entry.upload === null && entry.group !== 'plugin' && entry.group !== 'plugin-skill') entry.upload = false; };
const PLUGIN = 'superpowers@superpowers-marketplace';

test('I-2: plugin entries need confirmation like any other entry', async () => {
  const { ctx, api } = await fixtureHome();
  const e = bySlug(await planImport(ctx));
  assert.equal(e[PLUGIN].upload, null);
  assert.equal(e[`${PLUGIN}:brainstorming`].upload, null);
  await editPlan(ctx, standaloneOff);
  await assert.rejects(runImport({}, ctx), (err) => err instanceof UserError && /1 unconfirmed entries/.test(err.message));
  assert.equal(api.published.length, 0);
});

test('I-2: interactive import asks once per plugin and its skills follow that answer', async () => {
  for (const answer of ['y', 'n']) {
    const { home, ctx, api } = await fixtureHome();
    await makeDir({ 'plugins/sp/skills/tdd/SKILL.md': skillMd('tdd') }, home);
    await planImport(ctx);
    await editPlan(ctx, standaloneOff);
    ctx.prompt = scriptedPrompt([answer]);
    const report = await runImport({ interactive: true }, ctx);
    assert.equal(ctx.prompt.asked.length, 1, ctx.prompt.asked.join(' | '));
    assert.match(ctx.prompt.asked[0], new RegExp(`Upload ${PLUGIN} \\(plugin`));
    const slugs = api.published.map((p) => p.manifest.slug).sort();
    if (answer === 'y') assert.deepEqual(slugs, [PLUGIN, `${PLUGIN}:brainstorming`, `${PLUGIN}:tdd`, `${PLUGIN}:writing-plans`]);
    else {
      assert.deepEqual(slugs, []);
      assert.ok(report.skipped.includes(`${PLUGIN}:brainstorming`) && report.skipped.includes(`${PLUGIN}:tdd`));
    }
  }
});

test('I-2: a plugin-skill is skipped when its plugin is declined, even if marked true', async () => {
  const { ctx, api } = await fixtureHome();
  await planImport(ctx);
  await editPlan(ctx, (entry) => {
    standaloneOff(entry);
    if (entry.slug === PLUGIN) entry.upload = false;
    if (entry.slug === `${PLUGIN}:brainstorming`) entry.upload = true;
  });
  const report = await runImport({}, ctx);
  assert.deepEqual(api.published, []);
  assert.ok(report.skipped.includes(`${PLUGIN}:brainstorming`));
});

test('I-2: a plugin-skill with a secret is blocked', async () => {
  const { home, ctx, api } = await fixtureHome();
  await makeDir({ 'plugins/sp/skills/leaky-ps/SKILL.md': `${skillMd('leaky-ps')}\ntoken ghp_${'a'.repeat(36)}\n` }, home);
  await planImport(ctx);
  await editPlan(ctx, (entry) => { standaloneOff(entry); if (entry.slug === PLUGIN) entry.upload = true; });
  const report = await runImport({}, ctx);
  assert.deepEqual(report.blocked.map((b) => b.slug), [`${PLUGIN}:leaky-ps`]);
  assert.match(report.blocked[0].reason, /github-token in SKILL\.md:\d+/);
  assert.ok(!api.published.some((p) => p.manifest.slug === `${PLUGIN}:leaky-ps`));
  assert.ok(api.published.some((p) => p.manifest.slug === `${PLUGIN}:brainstorming`));
});

test('I-3: a lockfile entry whose local origin is under a work path is planned as work and never uploaded', async () => {
  const { home, ctx, api } = await fixtureHome();
  await mkdir(path.join(home, 'acme-work/client-repo'), { recursive: true });
  const { realpath } = await import('node:fs/promises');
  await writeFile(path.join(home, '.agents/.skill-lock.json'), JSON.stringify({ version: 3, skills: {
    humanizer: { sourceType: 'local', source: path.join(home, 'acme-work/client-repo') }, // exists → realpath
    leaky: { sourceType: 'local', source: '../Acme-Work/gone/leaky' }, // relative to ~/.agents, missing, other case
    'brand-naming': { sourceType: 'local', source: path.join(home, 'projects/brand') }, // not work
  } }));
  const e = bySlug(await planImport(ctx));
  assert.equal(e.humanizer.group, 'work');
  assert.equal(e.humanizer.upload, false);
  assert.equal(e.humanizer.origin, await realpath(path.join(home, 'acme-work/client-repo')));
  assert.equal(e.leaky.group, 'work');
  assert.equal(e.leaky.origin, path.join(home, 'Acme-Work/gone/leaky'));
  assert.equal(e['brand-naming'].group, 'lock');
  assert.equal(e['brand-naming'].upload, null);

  // A hand-edited plan cannot bring them back: runImport re-checks the origin.
  await editPlan(ctx, (entry) => {
    if (entry.slug === 'humanizer' || entry.slug === 'leaky') { entry.group = 'lock'; entry.upload = true; } else if (entry.upload === null && entry.slug !== 'brand-naming') entry.upload = false;
  });
  ctx.prompt = scriptedPrompt(['n']);
  const report = await runImport({ interactive: true }, ctx);
  assert.match(ctx.prompt.asked[0], new RegExp(`Upload brand-naming \\(lock, .*origin ${path.join(home, 'projects/brand').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!api.published.some((p) => ['humanizer', 'leaky'].includes(p.manifest.slug)));
  assert.ok(report.skipped.includes('humanizer') && report.skipped.includes('leaky'));
});

test('I-4: one failing entry does not abort the import; trim then refuses', async () => {
  const { home, ctx, api } = await fixtureHome();
  await planImport(ctx);
  await editPlan(ctx, (entry) => { if (entry.upload === null) entry.upload = entry.slug === 'humanizer' || entry.slug === 'remotion-render'; });
  const publish = api.publish;
  api.publish = async (m, t) => { if (m.slug === 'humanizer') throw Object.assign(new Error('HTTP 500'), { status: 500 }); return publish(m, t); };
  const report = await runImport({}, ctx);
  assert.deepEqual(report.failed, [{ slug: 'humanizer', reason: 'HTTP 500' }]);
  assert.deepEqual(report.published, ['remotion-render']);
  const saved = bySlug(JSON.parse(await readFile(planFile(ctx), 'utf8')));
  assert.equal(saved.humanizer.note, 'HTTP 500');
  assert.ok(!saved.humanizer.imported);
  assert.ok(saved['remotion-render'].imported);

  await assert.rejects(trim({}, ctx), (e) => e instanceof UserError && /humanizer/.test(e.message) && !/remotion-render/.test(e.message));
  assert.ok((await lstat(path.join(home, '.grok/skills/humanizer'))).isSymbolicLink(), 'nothing removed');
  assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink(), 'nothing removed');
  assert.ok(!(await readdir(ctx.dir)).some((n) => n.startsWith('backup-')), 'no backup written');
});

test('I-4: a tarball over 4 MB is refused before publishing', async () => {
  const { home, ctx, api } = await fixtureHome();
  const { randomBytes } = await import('node:crypto');
  await makeDir({ '.agents/skills/huge/SKILL.md': skillMd('huge'), '.agents/skills/huge/blob.bin': randomBytes(5 * 1024 * 1024) }, home);
  await planImport(ctx);
  await editPlan(ctx, (entry) => { if (entry.upload === null) entry.upload = entry.slug === 'huge' || entry.slug === 'humanizer'; });
  const report = await runImport({}, ctx);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].slug, 'huge');
  assert.match(report.failed[0].reason, /^tarball too large \(\d+ bytes\)$/);
  assert.ok(Number(report.failed[0].reason.match(/\d+/)[0]) > 4 * 1024 * 1024);
  assert.deepEqual(api.published.map((p) => p.manifest.slug), ['humanizer']);
});

test('M-4: a 409 counts as imported only when the current version has the same sha256', async () => {
  const { ctx, api } = await fixtureHome();
  await planImport(ctx);
  await editPlan(ctx, (entry) => { if (entry.upload === null) entry.upload = ['humanizer', 'remotion-render', 'brand-naming'].includes(entry.slug); });
  api.conflicts.add('humanizer'); // only a rejected version exists: getSkill has no current sha256
  api.conflicts.add('brand-naming');
  api.addSkill({ slug: 'brand-naming', files: [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('other content') }] });
  const report = await runImport({}, ctx);
  assert.deepEqual(report.failed.map((f) => f.slug).sort(), ['brand-naming', 'humanizer']);
  for (const f of report.failed) assert.equal(f.reason, 'a different or rejected version already exists');
  assert.deepEqual(report.existing, []);
  const saved = bySlug(JSON.parse(await readFile(planFile(ctx), 'utf8')));
  assert.ok(!saved.humanizer.imported && !saved['brand-naming'].imported);
  await assert.rejects(trim({}, ctx), /humanizer/);
});

test('trim validates settings.json before removing anything', async () => {
  const { home, ctx } = await fixtureHome();
  await planImport(ctx);
  await editPlan(ctx, (entry) => { if (entry.upload === null) entry.upload = entry.slug === 'remotion-render'; });
  await runImport({}, ctx);
  for (const bad of ['{ broken', '[]']) {
    await writeFile(path.join(home, '.claude/settings.json'), bad);
    await assert.rejects(trim({}, ctx), (e) => e instanceof UserError && /settings\.json/.test(e.message));
    assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink(), 'nothing removed');
    assert.ok((await lstat(path.join(home, '.codex/skills/remotion-render'))).isSymbolicLink(), 'nothing removed');
  }
});

// --- Follow-up: identical duplicate copies ---

test('trim removes a real-dir duplicate identical to the imported copy; restore brings it back', async () => {
  const { home, ctx } = await fixtureHome();
  const { rm } = await import('node:fs/promises');
  const dupClaude = path.join(home, '.claude/skills/humanizer');
  const dupCodex = path.join(home, '.codex/skills/humanizer');
  await makeDir({ 'SKILL.md': skillMd('humanizer') }, dupClaude);
  await makeDir({ 'SKILL.md': skillMd('humanizer') }, dupCodex);
  const all = (await planImport(ctx)).entries.filter((x) => x.slug === 'humanizer');
  assert.equal(all.length, 3);
  assert.match(all[0].path, /\.agents\/skills\/humanizer$/);
  const dups = all.slice(1);
  for (const d of dups) assert.equal(d.upload, false);
  for (const d of dups) assert.match(d.note, /duplicate slug/);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']); // humanizer, leaky, remotion-render, brand-naming, plugin
  await runImport({ interactive: true }, ctx);
  const res = await trim({}, ctx);
  assert.ok(res.removed.includes(dupClaude), res.removed.join(','));
  assert.ok(res.removed.includes(dupCodex), res.removed.join(','));
  assert.ok(!(await exists(dupClaude)) && !(await exists(dupCodex)));
  assert.ok(await exists(path.join(home, '.agents/skills/humanizer/SKILL.md')), '~/.agents untouched');
  await rm(path.join(home, '.claude/skills/skill-finder'));
  const out = await restore(res.backup, ctx);
  assert.ok(out.restored.includes(dupClaude) && out.restored.includes(dupCodex), out.restored.join(','));
  assert.ok(!(await lstat(dupClaude)).isSymbolicLink());
  assert.equal(await readFile(path.join(dupClaude, 'SKILL.md'), 'utf8'), skillMd('humanizer'));
});

test('trim keeps a same-slug copy that differs (or cannot be hashed) and warns', async () => {
  const { home, ctx } = await fixtureHome();
  const { realpath } = await import('node:fs/promises');
  const differs = path.join(home, '.claude/skills/humanizer');
  const withLink = path.join(home, '.codex/skills/humanizer');
  await makeDir({ 'SKILL.md': `${skillMd('humanizer')}\nlocal edit\n` }, differs);
  await makeDir({ 'SKILL.md': skillMd('humanizer') }, withLink);
  await symlink('SKILL.md', path.join(withLink, 'alias.md'));
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']);
  await runImport({ interactive: true }, ctx);
  const res = await trim({}, ctx);
  const imported = await realpath(path.join(home, '.agents/skills/humanizer'));
  for (const p of [differs, withLink]) {
    assert.ok(!res.removed.includes(p), p);
    assert.ok(await exists(path.join(p, 'SKILL.md')), p);
    assert.ok(ctx.log.lines.includes(`warning: ${p} differs from the imported copy (${imported}); keeping it`), ctx.log.text());
  }
});

test('trim never removes a same-slug entry that resolves under a work path, even if identical', async () => {
  const { home, ctx } = await fixtureHome();
  const workCopy = path.join(home, 'acme-work/client/humanizer');
  await makeDir({ 'SKILL.md': skillMd('humanizer') }, workCopy);
  const link = path.join(home, '.claude/skills/humanizer');
  await symlink(workCopy, link);
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']);
  await runImport({ interactive: true }, ctx);
  const res = await trim({}, ctx);
  assert.ok(!res.removed.includes(link), res.removed.join(','));
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.ok(await exists(path.join(workCopy, 'SKILL.md')));
});

// --- Trim/restore across the harness registry ---

const DETECTED = ['claude', 'codex', 'grok', 'gemini', 'windsurf', 'pi'];
async function registryHome(opts) {
  const f = await fixtureHome(opts);
  const { home, ctx } = f;
  await makeDir({
    '.headjack/harnesses.json': JSON.stringify({ harnesses: DETECTED }),
    '.gemini/skills/humanizer/SKILL.md': skillMd('humanizer'), // identical vendored copy → removed
    '.gemini/skills/remotion-render/SKILL.md': `${skillMd('remotion-render')}\nvendored edit\n`, // differs → kept
    '.gemini/skills/vendored-only/SKILL.md': skillMd('vendored-only'), // never planned → not in vault
    '.gemini/skills/leaky/SKILL.md': skillMd('leaky'), // planned, declined → not imported
    '.gemini/skills/.DS_Store': 'x',
    '.codeium/windsurf/skills/humanizer/SKILL.md': skillMd('humanizer'),
    'elsewhere/pi-skills/humanizer/SKILL.md': skillMd('humanizer'),
  }, home);
  await mkdir(path.join(home, '.pi/agent'), { recursive: true });
  await symlink(path.join(home, 'elsewhere/pi-skills'), path.join(home, '.pi/agent/skills')); // symlinked parent → never deleted through
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']); // humanizer, leaky, remotion-render, brand-naming, plugin
  await runImport({ interactive: true }, ctx);
  return f;
}
const report = (res, id) => res.harnesses.find((h) => h.id === id);
const reasons = (r) => Object.fromEntries(r.keep.map((k) => [path.basename(k.path), k.reason]));

test('the import plan still scans only ~/.agents and the built-in trio', async () => {
  const { ctx } = await registryHome();
  const plan = JSON.parse(await readFile(path.join(ctx.dir, 'import-plan.json'), 'utf8'));
  assert.ok(!plan.entries.some((x) => x.slug === 'vendored-only'));
  assert.ok(!plan.entries.some((x) => x.path.includes('.gemini') || x.path.includes('.codeium')));
});

test('trim covers every detected harness: identical copies go, the rest stay with a reason; restore undoes it', async () => {
  const { home, ctx } = await registryHome({ core: CORE });
  const res = await trim({}, ctx);
  const gemini = report(res, 'gemini');
  assert.deepEqual(gemini.remove, [path.join(home, '.gemini/skills/humanizer')]);
  assert.deepEqual(reasons(gemini), { leaky: 'not-imported', 'remotion-render': 'differs', 'vendored-only': 'not-in-vault' });
  assert.deepEqual(report(res, 'windsurf').remove, [path.join(home, '.codeium/windsurf/skills/humanizer')]);
  assert.equal(report(res, 'pi').symlinked, true);
  assert.ok(res.removed.includes(path.join(home, '.gemini/skills/humanizer')));
  assert.ok(res.removed.includes(path.join(home, '.codeium/windsurf/skills/humanizer')));
  assert.ok(res.removed.includes(path.join(home, '.claude/skills/remotion-render')), 'trio still trimmed');
  assert.ok(!(await exists(path.join(home, '.gemini/skills/humanizer'))));
  assert.ok(await exists(path.join(home, 'elsewhere/pi-skills/humanizer/SKILL.md')), 'not deleted through a symlinked dir');
  for (const name of ['remotion-render', 'vendored-only', 'leaky']) assert.ok(await exists(path.join(home, '.gemini/skills', name, 'SKILL.md')), name);
  for (const rel of ['.gemini/skills', '.codeium/windsurf/skills']) assert.ok((await lstat(path.join(home, rel, 'skill-finder'))).isSymbolicLink(), rel);
  const record = JSON.parse(await readFile(path.join(res.backup, 'backup.json'), 'utf8'));
  for (const rel of ['.agents/skills', '.claude/skills', '.gemini/skills', '.codeium/windsurf/skills', '.pi/agent/skills']) assert.ok(record.dirs.includes(path.join(home, rel)), rel);
  assert.equal(record.settings, path.join(home, '.claude/settings.json'));
  assert.equal(JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')).enabledPlugins['noncore-plugin@example'], false);

  const { rm } = await import('node:fs/promises');
  await rm(path.join(home, '.codeium'), { recursive: true });
  const out = await restore(res.backup, ctx);
  assert.ok(out.restored.includes(path.join(home, '.gemini/skills/humanizer')), out.restored.join(','));
  assert.equal(await readFile(path.join(home, '.gemini/skills/humanizer/SKILL.md'), 'utf8'), skillMd('humanizer'));
  assert.equal(await readFile(path.join(home, '.codeium/windsurf/skills/humanizer/SKILL.md'), 'utf8'), skillMd('humanizer'));
});

test('trim guards hold in a new harness: work paths and broken links are kept', async () => {
  const { home, ctx } = await fixtureHome();
  const workCopy = path.join(home, 'acme-work/client/humanizer');
  await makeDir({ 'SKILL.md': skillMd('humanizer') }, workCopy);
  await makeDir({ '.headjack/harnesses.json': JSON.stringify({ harnesses: ['gemini', 'cursor'] }) }, home);
  await mkdir(path.join(home, '.gemini/skills'), { recursive: true });
  await mkdir(path.join(home, '.cursor/skills'), { recursive: true });
  await symlink(workCopy, path.join(home, '.gemini/skills/humanizer'));
  await symlink('/nonexistent/remotion', path.join(home, '.cursor/skills/remotion-render'));
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']);
  await runImport({ interactive: true }, ctx);
  const res = await trim({}, ctx);
  assert.deepEqual(reasons(report(res, 'gemini')), { humanizer: 'work-path' });
  assert.deepEqual(reasons(report(res, 'cursor')), { 'remotion-render': 'broken' });
  assert.deepEqual(res.removed, []);
  assert.ok((await lstat(path.join(home, '.gemini/skills/humanizer'))).isSymbolicLink());
  assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink(), 'claude not detected → not trimmed');
});

test('trim --dry-run reports per harness and changes nothing', async () => {
  const { home, ctx } = await registryHome({ core: CORE });
  const settingsBefore = await readFile(path.join(home, '.claude/settings.json'), 'utf8');
  const res = await trim({ dryRun: true }, ctx);
  assert.equal(res.dryRun, true);
  assert.equal(res.backup, undefined);
  assert.deepEqual(report(res, 'gemini').remove, [path.join(home, '.gemini/skills/humanizer')]);
  assert.deepEqual(reasons(report(res, 'gemini')), { leaky: 'not-imported', 'remotion-render': 'differs', 'vendored-only': 'not-in-vault' });
  assert.deepEqual(res.disabled, ['superpowers@superpowers-marketplace', 'noncore-plugin@example']);
  assert.equal(res.plugins, 'trimmed');
  assert.ok(res.finder.includes(path.join(home, '.gemini/skills/skill-finder')));
  assert.ok(await exists(path.join(home, '.gemini/skills/humanizer/SKILL.md')));
  assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink());
  assert.ok(!(await exists(path.join(home, '.gemini/skills/skill-finder'))));
  assert.equal(await readFile(path.join(home, '.claude/settings.json'), 'utf8'), settingsBefore);
  assert.ok(!(await readdir(ctx.dir)).some((n) => n.startsWith('backup-')), 'no backup');
  assert.equal(ctx.log.text(), '', 'the report is the output; no warnings');
});

test('trim --only-harness limits removal and skill-finder to those harnesses and leaves settings alone', async () => {
  const { home, ctx } = await registryHome();
  const settingsBefore = await readFile(path.join(home, '.claude/settings.json'), 'utf8');
  const res = await trim({ onlyHarness: 'gemini,windsurf' }, ctx);
  assert.deepEqual(res.harnesses.map((h) => h.id), ['gemini', 'windsurf']);
  assert.deepEqual(res.removed.sort(), [path.join(home, '.codeium/windsurf/skills/humanizer'), path.join(home, '.gemini/skills/humanizer')].sort());
  assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink(), 'claude untouched');
  assert.ok(!(await exists(path.join(home, '.claude/skills/skill-finder'))));
  assert.ok((await lstat(path.join(home, '.gemini/skills/skill-finder'))).isSymbolicLink());
  assert.deepEqual(res.disabled, []);
  assert.equal(await readFile(path.join(home, '.claude/settings.json'), 'utf8'), settingsBefore, 'plugins are trimmed only with claude');
  const record = JSON.parse(await readFile(path.join(res.backup, 'backup.json'), 'utf8'));
  assert.ok(record.dirs.includes(path.join(home, '.claude/skills')), 'backup still covers every detected harness');
  assert.ok(await exists(path.join(res.backup, 'settings.json')), 'settings backed up');
  assert.equal(record.settings, null, 'restore leaves settings alone: this trim did not change them');
  await assert.rejects(trim({ onlyHarness: 'nope' }, ctx), (e) => e instanceof UserError && /unknown harness: nope/.test(e.message));
});

// --- Fix round 1 (harness lifecycle review) ---

test('C-1: an empty or comma-only --only-harness is an error, not "every harness"', async () => {
  const { home, ctx } = await registryHome();
  for (const bad of ['', ',', ' , ']) {
    for (const dryRun of [true, false]) {
      await assert.rejects(trim({ onlyHarness: bad, dryRun }, ctx), (e) => e instanceof UserError && /--only-harness/.test(e.message), JSON.stringify(bad));
    }
  }
  assert.ok(await exists(path.join(home, '.gemini/skills/humanizer/SKILL.md')));
  assert.ok((await lstat(path.join(home, '.claude/skills/remotion-render'))).isSymbolicLink());
  assert.ok(!(await readdir(ctx.dir)).some((n) => n.startsWith('backup-')));
});

test('I-1: trim keeps an headjack-managed store link (reason managed), so state.json stays valid', async () => {
  const { home, ctx } = await registryHome();
  const { rm, cp } = await import('node:fs/promises');
  const link = path.join(home, '.codeium/windsurf/skills/humanizer');
  await rm(link, { recursive: true });
  const tmp = path.join(ctx.dir, 'store', 'tmp', 'humanizer');
  await cp(path.join(home, '.agents/skills/humanizer'), tmp, { recursive: true });
  const sha = await hashDir(tmp);
  const stored = path.join(ctx.dir, 'store', sha, 'humanizer');
  await cp(tmp, stored, { recursive: true });
  await rm(path.dirname(tmp), { recursive: true });
  await symlink(stored, link);
  await writeFile(path.join(ctx.dir, 'state.json'), JSON.stringify({ version: 1, active: [{ slug: 'humanizer', kind: 'skill', sha256: sha, targets: [{ harness: 'windsurf', path: link }] }] }));

  const dry = await trim({ dryRun: true }, ctx);
  assert.deepEqual(report(dry, 'windsurf').remove, []);
  assert.deepEqual(reasons(report(dry, 'windsurf')), { humanizer: 'managed' });
  const res = await trim({}, ctx);
  assert.ok(!res.removed.includes(link), res.removed.join(','));
  assert.ok(res.removed.includes(path.join(home, '.gemini/skills/humanizer')), 'unmanaged identical copies still go');
  assert.equal(await readlink(link), stored);
  assert.deepEqual(await verify(ctx), []);
});

// The state dir can be reached through a symlink (~/.headjack -> a legacy state directory); trim must still see the link as managed.
for (const [made, judged] of [['alias', 'real'], ['real', 'alias']]) {
  test(`I-1: trim keeps a managed store link made via the ${made} spelling of the state dir, judged via the ${judged} one`, async () => {
    const { home, ctx } = await registryHome();
    const { rm, cp } = await import('node:fs/promises');
    const spell = { real: ctx.dir, alias: path.join(home, 'alias-state') };
    await symlink(spell.real, spell.alias);
    const link = path.join(home, '.codeium/windsurf/skills/humanizer');
    await rm(link, { recursive: true });
    const tmp = path.join(spell.real, 'store', 'tmp', 'humanizer');
    await cp(path.join(home, '.agents/skills/humanizer'), tmp, { recursive: true });
    const sha = await hashDir(tmp);
    await rm(path.dirname(tmp), { recursive: true });
    const stored = path.join(spell[made], 'store', sha, 'humanizer');
    await mkdir(path.dirname(path.join(spell.real, 'store', sha, 'humanizer')), { recursive: true });
    await cp(path.join(home, '.agents/skills/humanizer'), path.join(spell.real, 'store', sha, 'humanizer'), { recursive: true });
    await symlink(stored, link);

    const judge = { ...ctx, dir: spell[judged] };
    const dry = await trim({ dryRun: true }, judge);
    assert.deepEqual(report(dry, 'windsurf').remove, []);
    assert.deepEqual(reasons(report(dry, 'windsurf')), { humanizer: 'managed' });
    const res = await trim({}, judge);
    assert.ok(!res.removed.includes(link), res.removed.join(','));
    assert.equal(await readlink(link), stored);
  });
}

test('trim does not abort on a looping link in a harness skills dir: it is kept as unmanaged', async () => {
  const { home, ctx } = await registryHome();
  const loop = path.join(home, '.gemini/skills/loopy');
  await symlink('loopy', loop);
  const dry = await trim({ dryRun: true }, ctx);
  assert.ok(report(dry, 'gemini').keep.some((k) => k.path === loop), 'listed, not removed');
  assert.deepEqual(report(dry, 'gemini').remove.filter((p) => p === loop), []);
  const res = await trim({}, ctx);
  assert.ok(!res.removed.includes(loop));
  assert.equal(await readlink(loop), 'loopy');
});

test('I-2: restore skips a harness base that is a (relative) symlink in the backup and goes on past a failing dir', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  const { rm } = await import('node:fs/promises');
  await makeDir({
    '.headjack/harnesses.json': JSON.stringify({ harnesses: ['claude', 'codex', 'grok', 'pi', 'gemini'] }),
    '.gemini/skills/humanizer/SKILL.md': skillMd('humanizer'),
    'elsewhere/pi/mine/SKILL.md': skillMd('mine'),
  }, home);
  await mkdir(path.join(home, '.pi/agent'), { recursive: true });
  await symlink('../../elsewhere/pi', path.join(home, '.pi/agent/skills'));
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']);
  await runImport({ interactive: true }, ctx);
  const res = await trim({}, ctx);
  assert.ok(res.removed.includes(path.join(home, '.gemini/skills/humanizer')));
  assert.ok((await lstat(path.join(res.backup, '.pi/agent/skills'))).isSymbolicLink(), 'the backup keeps the link verbatim');

  // A dir missing from the backup fails on its own; the rest (and settings) are still restored.
  await rm(path.join(res.backup, '.codex/skills'), { recursive: true });
  const out = await restore(res.backup, ctx);
  assert.ok(out.restored.includes(path.join(home, '.gemini/skills/humanizer')), out.restored.join(','));
  assert.ok(out.restored.includes(path.join(home, '.claude/skills/remotion-render')));
  assert.deepEqual(out.skipped, [path.join(home, '.pi/agent/skills')]);
  assert.deepEqual(out.failed.map((f) => f.dir), [path.join(home, '.codex/skills')]);
  assert.ok(out.settings);
  assert.ok(await exists(path.join(home, 'elsewhere/pi/mine/SKILL.md')));
  assert.equal(await readlink(path.join(home, '.pi/agent/skills')), '../../elsewhere/pi');
});

test('I-3: skill-finder is never installed through a symlinked harness dir or into a work path; dry-run count matches', async () => {
  const { home, ctx } = await registryHome();
  await makeDir({ 'acme-work/client/skills/.keep': '' }, home);
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await symlink(path.join(home, 'acme-work/client/skills'), path.join(home, '.cursor/skills')); // symlinked into a work path
  await symlink(path.join(home, 'acme-work/client'), path.join(home, '.kiro')); // parent symlinked, skills dir not there yet
  const only = 'gemini,pi,cursor,kiro';
  const dry = await trim({ onlyHarness: only, dryRun: true }, ctx);
  assert.deepEqual(dry.finder, [path.join(home, '.gemini/skills/skill-finder')]);
  const res = await trim({ onlyHarness: only }, ctx);
  assert.deepEqual(res.finder, dry.finder, 'the dry-run count is what the real run does');
  assert.ok(!(await exists(path.join(home, 'elsewhere/pi-skills/skill-finder'))), 'not through the symlinked pi dir');
  assert.deepEqual((await readdir(path.join(home, 'acme-work/client/skills'))).sort(), ['.keep'], 'nothing written into the work path');
  assert.ok(!(await exists(path.join(home, 'acme-work/client/skills/skill-finder'))));
});

test('I-5: re-planning keeps upload, imported, note and sha256 of entries with the same slug and path', async () => {
  const { ctx } = await fixtureHome();
  await planImport(ctx);
  ctx.prompt = scriptedPrompt(['y', 'n', 'y', 'n', 'n']); // humanizer, leaky, remotion-render, brand-naming, plugin
  await runImport({ interactive: true }, ctx);
  const before = bySlug(JSON.parse(await readFile(path.join(ctx.dir, 'import-plan.json'), 'utf8')));
  const plan = bySlug(await planImport(ctx));
  for (const slug of ['humanizer', 'remotion-render', 'leaky', 'brand-naming', 'superpowers@superpowers-marketplace']) {
    for (const k of ['upload', 'imported', 'note', 'sha256']) assert.deepEqual(plan[slug][k], before[slug][k], `${slug}.${k}`);
  }
  assert.equal(plan.humanizer.imported, true);
  assert.equal(plan['client-skill'].upload, false, 'forced decisions still come from the scan');
  // A trim right after re-planning still sees the imported entries.
  const res = await trim({ dryRun: true }, ctx);
  assert.ok(res.harnesses.find((h) => h.id === 'grok').remove.length, 'grok/humanizer still trimmable');
});

test('M-1: import records the folder hash; trim compares against it when the imported copy is gone', async () => {
  const { home, ctx } = await registryHome();
  const { rm } = await import('node:fs/promises');
  const plan = bySlug(JSON.parse(await readFile(path.join(ctx.dir, 'import-plan.json'), 'utf8')));
  assert.equal(plan.humanizer.sha256, await hashDir(path.join(home, '.agents/skills/humanizer')));
  assert.equal(plan['superpowers@superpowers-marketplace'].sha256, undefined, 'only folder skills');
  await rm(path.join(home, '.agents/skills/humanizer'), { recursive: true });
  const res = await trim({ dryRun: true }, ctx);
  assert.deepEqual(report(res, 'gemini').remove, [path.join(home, '.gemini/skills/humanizer')]);
  assert.equal(reasons(report(res, 'gemini'))['remotion-render'], 'differs', 'a differing copy is still kept');
});

// --- Configurable excluded roots ---

test('trim never places skill-finder into an excluded root, even a real harness dir', async () => {
  const { home, ctx } = await fixtureHome();
  await writeFile(path.join(ctx.dir, 'config.json'), JSON.stringify({ excludedRoots: ['~/.codex'] }));
  await planImport(ctx);
  const res = await trim({}, ctx);
  assert.ok(res.finder.includes(path.join(home, '.claude/skills/skill-finder')), res.finder.join(','));
  assert.ok(!res.finder.includes(path.join(home, '.codex/skills/skill-finder')), res.finder.join(','));
  assert.ok((await lstat(path.join(home, '.claude/skills/skill-finder'))).isSymbolicLink());
  assert.ok(!(await exists(path.join(home, '.codex/skills/skill-finder'))));
});

test('without config nothing is excluded: plan, import and trim treat ~/acme-work like any other path', async () => {
  const { home, ctx, api } = await fixtureHome();
  const { rm } = await import('node:fs/promises');
  await rm(path.join(ctx.dir, 'config.json'));
  const workCopy = path.join(home, 'acme-work/client/humanizer');
  await makeDir({ 'SKILL.md': skillMd('humanizer') }, workCopy);
  await makeDir({ '.headjack/harnesses.json': JSON.stringify({ harnesses: ['gemini'] }) }, home);
  await mkdir(path.join(home, '.gemini/skills'), { recursive: true });
  await symlink(workCopy, path.join(home, '.gemini/skills/humanizer'));
  const e = bySlug(await planImport(ctx));
  assert.equal(e['client-skill'].group, 'local');
  assert.equal(e['client-skill'].upload, null);
  await editPlan(ctx, (entry) => { entry.upload = entry.slug === 'client-skill' || entry.slug === 'humanizer'; });
  const imported = await runImport({}, ctx);
  assert.ok(imported.published.includes('client-skill'), JSON.stringify(imported));
  assert.ok(api.published.some((p) => p.manifest.slug === 'client-skill'));
  const res = await trim({}, ctx);
  assert.deepEqual(report(res, 'gemini').remove, [path.join(home, '.gemini/skills/humanizer')], 'an identical copy under ~/acme-work goes');
});

// Headjack's own plugin (an invented marketplace key): its skills ship with the plugin, never through the vault.
async function withHeadjackPlugin(home, { enabled = true } = {}) {
  await makeDir({
    'plugins/hj/.claude-plugin/plugin.json': JSON.stringify({ name: 'headjack', skills: ['./skill-finder', './writing-skills'] }),
    'plugins/hj/skill-finder/SKILL.md': skillMd('skill-finder'),
    'plugins/hj/writing-skills/SKILL.md': skillMd('writing-skills'),
    'plugins/hj/cli/headjack': '#!/bin/sh\n',
  }, home);
  const installedFile = path.join(home, '.claude/plugins/installed_plugins.json');
  const installed = JSON.parse(await readFile(installedFile, 'utf8'));
  installed.plugins['headjack@acme-market'] = [{ scope: 'user', installPath: path.join(home, 'plugins/hj'), version: '0.5.4' }];
  await writeFile(installedFile, JSON.stringify(installed));
  const settingsFile = path.join(home, '.claude/settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  settings.enabledPlugins['headjack@acme-market'] = enabled;
  await writeFile(settingsFile, JSON.stringify(settings));
}

test('the plan never offers headjack itself or its skills to the vault', async () => {
  const { home, ctx } = await fixtureHome();
  await withHeadjackPlugin(home);
  const e = bySlug(await planImport(ctx));
  assert.equal(e['headjack@acme-market'].upload, false);
  assert.match(e['headjack@acme-market'].note, /headjack itself/);
  assert.deepEqual(Object.keys(e).filter((s) => s.startsWith('headjack@acme-market:')), [], 'no per-skill rows for its skills');
});

test('trim keeps headjack itself enabled even when it is not in the core', async () => {
  const { home, ctx } = await fixtureHome({ core: CORE });
  await withHeadjackPlugin(home);
  await planImport(ctx);
  await trim({}, ctx);
  const on = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')).enabledPlugins;
  assert.equal(on['headjack@acme-market'], true);
  assert.equal(on['noncore-plugin@example'], false, 'other non-core plugins are still trimmed');
});

test('trim does not link skill-finder into Claude Code when the headjack plugin is enabled there', async () => {
  const { home, ctx } = await fixtureHome();
  await withHeadjackPlugin(home);
  await planImport(ctx);
  const res = await trim({}, ctx);
  assert.ok(!(await exists(path.join(home, '.claude/skills/skill-finder'))), 'the plugin already gives Claude Code headjack:skill-finder');
  assert.ok(!res.finder.includes(path.join(home, '.claude/skills/skill-finder')));
  assert.ok((await lstat(path.join(home, '.codex/skills/skill-finder'))).isSymbolicLink(), 'other harnesses still get it');
});

test('trim still links skill-finder into Claude Code when the headjack plugin is installed but disabled', async () => {
  const { home, ctx } = await fixtureHome();
  await withHeadjackPlugin(home, { enabled: false });
  await planImport(ctx);
  await trim({}, ctx);
  assert.ok((await lstat(path.join(home, '.claude/skills/skill-finder'))).isSymbolicLink());
});
