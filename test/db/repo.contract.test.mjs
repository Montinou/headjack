// The repository contract both backends keep: the Postgres repo (lib/repo.mjs, on PGlite as the app role) and the local
// SQLite repo (lib/local/sqlite-repo.mjs). Results are compared as the JSON the handlers would send. The SQLite FTS index
// includes the skill body and the Postgres one does not, so search asserts matching, never ranking order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDb } from '../../lib/db.mjs';
import { repoForOwner } from '../../lib/repo.mjs';
import { ConflictError } from '../../lib/errors.mjs';
import { appPool, closePg, migratedPg, vec } from '../pglite.mjs';
import { tempDir } from '../helpers.mjs';
import { localSupported, localTest } from '../local-helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};

const json = (x) => JSON.parse(JSON.stringify(x));
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const sha = (c) => c.repeat(64);
const commit = (c) => c.repeat(40);
const GF = 'grandfathered: instalada antes del vault, no revisada';
const content = (text) => ({ text, embedding: vec(0) });

const skill = (slug, over = {}) => ({
  slug, name: slug, description: `the ${slug} skill`, kind: 'skill', tags: [],
  source: { kind: 'github', url: `https://github.com/x/${slug}` }, source_path: `skills/${slug}`,
  commit_sha: commit('a'), sha256: sha('1'), status: 'approved', review_notes: 'ok', scan_flags: [],
  ...over,
});

async function postgresBackend() {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  const repo = repoForOwner(db.withOwner, await db.resolveOwner('user', 'contract'));
  return { repo, close: () => closePg(pg) };
}

async function sqliteBackend() {
  const db = openVault({ dir: await tempDir('sv-contract-'), DatabaseSync });
  return { repo: createSqliteRepo(db), close: () => db.close() };
}

function contract(label, makeRepo, define = test) {
  const it = (name, fn) =>
    define(`${label}: ${name}`, async () => {
      const backend = await makeRepo();
      try {
        await fn(backend.repo);
      } finally {
        await backend.close();
      }
    });

  it('publish returns { skillId, versionId }, getSkill returns the manifest fields, and a duplicate (slug, sha256) is a ConflictError', async (repo) => {
    const m = skill('quokka-export', {
      description: 'Export a quokka video', tags: ['lantern', 'video'], scan_flags: [{ rule: 'curl-pipe', file: 'SKILL.md' }],
    });
    const r = await repo.publish({ manifest: m, tarball: Buffer.from('tgz'), chunks: [content('quokka body')] });
    assert.deepEqual(Object.keys(r).sort(), ['skillId', 'versionId']);
    assert.ok(Number.isInteger(r.skillId) && r.skillId > 0);
    assert.ok(Number.isInteger(r.versionId) && r.versionId > 0);

    const { reviewed_at, ...got } = json(await repo.getSkill('quokka-export'));
    assert.match(reviewed_at, ISO);
    assert.deepEqual(got, {
      slug: m.slug, name: m.name, description: m.description, kind: 'skill', plugin_slug: null, tags: m.tags, quality: null,
      source_path: m.source_path, source_kind: 'github', source_url: m.source.url, default_ref: 'HEAD',
      commit_sha: m.commit_sha, sha256: m.sha256, size: 3, review_notes: 'ok', scan_flags: m.scan_flags,
      update_available: false, latest_commit: m.commit_sha,
    });
    assert.equal(await repo.getSkill('nope'), null);

    assert.deepEqual(json(await repo.getSkillsByIds([r.skillId])), [{
      id: r.skillId, slug: m.slug, name: m.name, description: m.description, kind: 'skill', plugin_slug: null,
      tags: m.tags, quality: null, review_notes: 'ok', update_available: false,
    }]);
    assert.deepEqual(await repo.getSkillsByIds([]), []);

    await assert.rejects(repo.publish({ manifest: m, tarball: Buffer.from('tgz'), chunks: [content('x')] }), ConflictError);
    await assert.rejects(repo.publish({ manifest: { ...m, status: 'rejected' }, tarball: null, chunks: [] }), ConflictError);
  });

  it('an approved v2 becomes current and a rejected v3 does not; versions, reviews and tarball follow', async (repo) => {
    const slug = 'tapir-docs';
    await repo.publish({ manifest: skill(slug, { description: 'v1', tags: ['one'] }), tarball: Buffer.from('v1-bytes'), chunks: [content('v1')] });
    await repo.publish({
      manifest: skill(slug, { description: 'Render tapir documents', tags: ['docs'], commit_sha: commit('b'), sha256: sha('2') }),
      tarball: Buffer.from('v2-bytes'), chunks: [content('v2')],
    });
    await repo.publish({
      manifest: skill(slug, { name: 'renamed', description: 'tampered', tags: ['evil'], commit_sha: commit('c'), sha256: sha('3'), status: 'rejected', review_notes: 'no' }),
      tarball: null, chunks: [],
    });

    const s = json(await repo.getSkill(slug));
    assert.equal(s.sha256, sha('2'));
    assert.deepEqual([s.name, s.description, s.tags], [slug, 'Render tapir documents', ['docs']], 'the rejected publish changes no descriptive field');

    const versions = json(await repo.listVersions(slug));
    assert.deepEqual(versions.map((v) => v.sha256), [sha('3'), sha('2'), sha('1')], 'newest first');
    assert.deepEqual(versions.map((v) => v.current), [false, true, false]);
    assert.deepEqual(versions.map((v) => v.status), ['rejected', 'approved', 'approved']);
    assert.deepEqual(versions.map((v) => v.size), [null, 8, 8]);
    assert.deepEqual(Object.keys(versions[0]).sort(), ['commit_sha', 'current', 'id', 'review_notes', 'reviewed_at', 'scan_flags', 'sha256', 'size', 'status']);
    assert.ok(versions.every((v) => Number.isInteger(v.id) && ISO.test(v.reviewed_at) && Array.isArray(v.scan_flags)));

    const reviews = json(await repo.listReviews(slug));
    assert.deepEqual(reviews.map((r) => [r.commit_sha, r.status, r.current, r.sha256, r.review_notes]), [
      [commit('c'), 'rejected', false, sha('3'), 'no'],
      [commit('b'), 'approved', true, sha('2'), 'ok'],
      [commit('a'), 'approved', false, sha('1'), 'ok'],
    ]);
    assert.deepEqual(Object.keys(reviews[0]).sort(), ['commit_sha', 'current', 'review_notes', 'reviewed_at', 'sha256', 'status']);

    const tb = await repo.getTarball(slug);
    assert.equal(Buffer.from(tb.tarball).toString(), 'v2-bytes');
    assert.deepEqual([tb.kind, tb.plugin_slug, tb.sha256], ['skill', null, sha('2')]);
    assert.equal(await repo.getTarball('nope'), null);

    assert.equal(await repo.versionExists(slug, sha('3')), true);
    assert.equal(await repo.versionExists(slug, sha('9')), false);
    assert.equal(await repo.versionExists('nope', sha('1')), false);
  });

  it('a rejected publish clears update_available', async (repo) => {
    const slug = 'flaky-notice';
    await repo.publish({ manifest: skill(slug), tarball: Buffer.from('t'), chunks: [content('x')] });
    const [target] = await repo.listUpstreamTargets();
    await repo.markUpstream(target.skill_id, commit('e'), true);
    assert.deepEqual((await repo.listUpdates({})).map((u) => u.slug), [slug]);
    assert.equal((await repo.getSkill(slug)).update_available, true);
    await repo.publish({ manifest: skill(slug, { commit_sha: commit('e'), sha256: sha('2'), status: 'rejected', review_notes: 'not yet' }), tarball: null, chunks: [] });
    assert.deepEqual(await repo.listUpdates({}), []);
    assert.equal((await repo.getSkill(slug)).update_available, false);
  });

  it('searchText matches a word in the name, the description and a tag, and filters by tags', async (repo) => {
    const a = await repo.publish({ manifest: skill('quokka-export', { description: 'Export a video', tags: ['lantern'] }), tarball: Buffer.from('a'), chunks: [content('first')] });
    const b = await repo.publish({
      manifest: skill('tapir-docs', { description: 'Render marmalade documents', tags: ['lantern', 'harbor'], sha256: sha('2') }),
      tarball: Buffer.from('b'), chunks: [content('second')],
    });
    // Only a rejected version: no current version, so never a search result.
    await repo.publish({ manifest: skill('walrus', { description: 'walrus', tags: ['harbor'], sha256: sha('3'), status: 'rejected' }), tarball: null, chunks: [] });
    const sorted = async (...args) => (await repo.searchText(...args)).sort((x, y) => x - y);
    assert.deepEqual(await repo.searchText('quokka', 10), [a.skillId], 'name');
    assert.deepEqual(await repo.searchText('marmalade', 10), [b.skillId], 'description');
    assert.deepEqual(await repo.searchText('harbor', 10), [b.skillId], 'tag');
    assert.deepEqual(await sorted('lantern', 10), [a.skillId, b.skillId].sort((x, y) => x - y));
    assert.deepEqual(await repo.searchText('lantern', 10, ['harbor']), [b.skillId], 'tags filter');
    assert.deepEqual(await repo.searchText('lantern', 10, ['harbor', 'missing']), [], 'every tag is required');
    assert.deepEqual(await repo.searchText('walrus', 10), []);
    assert.deepEqual(await repo.searchText('lantern', 1).then((ids) => ids.length), 1, 'limit');
  });

  it('listUpstreamTargets returns the baseline commit and checked_at; markUpstream then listUpdates', async (repo) => {
    const slug = 'audit-me';
    const { skillId } = await repo.publish({ manifest: skill(slug), tarball: Buffer.from('1'), chunks: [content('x')] });
    await repo.publish({ manifest: skill(slug, { commit_sha: commit('b'), sha256: sha('2') }), tarball: Buffer.from('2'), chunks: [content('x')] });
    // A local review with no commit never becomes the baseline.
    await repo.publish({ manifest: skill(slug, { commit_sha: null, sha256: sha('3'), status: 'rejected' }), tarball: null, chunks: [] });
    // Local sources are never upstream targets.
    await repo.publish({ manifest: skill('local-one', { source: { kind: 'local' }, commit_sha: null, sha256: sha('4') }), tarball: Buffer.from('l'), chunks: [content('x')] });

    const targets = json(await repo.listUpstreamTargets());
    assert.equal(targets.length, 1);
    const { checked_at, ...target } = targets[0];
    assert.match(checked_at, ISO);
    assert.deepEqual(target, {
      skill_id: skillId, kind: 'github', url: `https://github.com/x/${slug}`, default_ref: 'HEAD', commit_sha: commit('b'), source_path: `skills/${slug}`,
    });

    await repo.markUpstream(skillId, commit('c'), false);
    assert.deepEqual(await repo.listUpdates({}), [], 'a new commit that is not an update');
    await repo.markUpstream(skillId, commit('c'), true);
    const updates = json(await repo.listUpdates({}));
    assert.equal(updates.length, 1);
    const { checked_at: updateChecked, ...update } = updates[0];
    assert.match(updateChecked, ISO);
    assert.deepEqual(update, {
      slug, name: slug, current_commit: commit('b'), reviewed_commit: commit('b'), latest_commit: commit('c'),
      source_url: `https://github.com/x/${slug}`, source_path: `skills/${slug}`,
    });
    assert.deepEqual(json(await repo.listUpstreamTargets())[0].commit_sha, commit('b'));
  });

  it('listUpdates({ grandfathered: true }) lists the current versions whose review notes start with grandfathered:', async (repo) => {
    const local = (slug, sha256, review_notes) => ({ manifest: skill(slug, { source: { kind: 'local' }, commit_sha: null, sha256, review_notes }), tarball: Buffer.from(slug), chunks: [content(slug)] });
    await repo.publish(local('humanizer', sha('1'), GF));
    await repo.publish(local('brand-naming', sha('2'), GF));
    await repo.publish(local('reviewed', sha('3'), 'ok'));
    const rows = json(await repo.listUpdates({ grandfathered: true }));
    assert.deepEqual(rows.map((r) => r.slug), ['brand-naming', 'humanizer']);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['name', 'reviewed_at', 'slug']);
    assert.ok(rows.every((r) => ISO.test(r.reviewed_at)));
  });

  it('the grandfathered prefix is matched case-sensitively', async (repo) => {
    const local = (slug, sha256, review_notes) => ({ manifest: skill(slug, { source: { kind: 'local' }, commit_sha: null, sha256, review_notes }), tarball: Buffer.from(slug), chunks: [content(slug)] });
    await repo.publish(local('lower', sha('1'), 'grandfathered: before the vault'));
    await repo.publish(local('capitalized', sha('2'), 'Grandfathered: before the vault'));
    await repo.publish(local('upper', sha('3'), 'GRANDFATHERED: before the vault'));
    assert.deepEqual(json(await repo.listUpdates({ grandfathered: true })).map((r) => r.slug), ['lower']);
  });

  it('listSkills pages the catalog by name then slug, filters by kind and tags, and totals before paging', async (repo) => {
    const add = (slug, over, n) => repo.publish({ manifest: skill(slug, { sha256: sha(String(n)), ...over }), tarball: Buffer.from(slug), chunks: [content(slug)] });
    await add('zeta', { name: 'Same', tags: ['fruit', 'red'] }, 1);
    await add('alpha', { name: 'Same', tags: ['fruit'] }, 2);
    await add('mango', { name: 'Mango', tags: ['fruit', 'red'] }, 3);
    await add('toolbox', { name: 'Toolbox', kind: 'plugin', tags: ['tools'] }, 4);
    await add('draft', { name: 'Draft', status: 'rejected', tags: ['fruit'] }, 5);

    const everything = json(await repo.listSkills({ tags: [], limit: 100, offset: 0 }));
    assert.deepEqual(everything.skills.map((s) => s.slug), ['draft', 'mango', 'alpha', 'zeta', 'toolbox'], 'ordered by name, then slug');
    assert.equal(everything.total, 5);
    assert.deepEqual(Object.keys(everything.skills[0]).sort(), [
      'description', 'has_approved_version', 'kind', 'name', 'plugin_slug', 'quality', 'slug', 'tags', 'update_available',
    ]);
    assert.deepEqual(everything.skills.find((s) => s.slug === 'mango'), {
      slug: 'mango', name: 'Mango', description: 'the mango skill', kind: 'skill', plugin_slug: null, tags: ['fruit', 'red'],
      quality: null, update_available: false, has_approved_version: true,
    });
    assert.equal(everything.skills.find((s) => s.slug === 'draft').has_approved_version, false, 'browse keeps a skill with no approved version');

    const plugins = json(await repo.listSkills({ kind: 'plugin', tags: [], limit: 100, offset: 0 }));
    assert.deepEqual([plugins.skills.map((s) => s.slug), plugins.total], [['toolbox'], 1]);

    const red = json(await repo.listSkills({ tags: ['fruit', 'red'], limit: 100, offset: 0 }));
    assert.deepEqual([red.skills.map((s) => s.slug), red.total], [['mango', 'zeta'], 2], 'a skill must carry every tag');
    assert.deepEqual(json(await repo.listSkills({ kind: 'plugin', tags: ['fruit'], limit: 10, offset: 0 })), { skills: [], total: 0 });

    const page = json(await repo.listSkills({ tags: [], limit: 2, offset: 1 }));
    assert.deepEqual([page.skills.map((s) => s.slug), page.total], [['mango', 'alpha'], 5], 'total is the count before paging');
    const past = json(await repo.listSkills({ tags: [], limit: 2, offset: 9 }));
    assert.deepEqual(past, { skills: [], total: 5 });
  });
}

contract('postgres', postgresBackend);
contract('sqlite', sqliteBackend, localTest);

// SQLite only.

const sqliteIt = (name, fn) =>
  localTest(`sqlite: ${name}`, async () => {
    const backend = await sqliteBackend();
    try {
      await fn(backend.repo);
    } finally {
      backend.close();
    }
  });

sqliteIt('rows are plain objects with real booleans, parsed arrays and ISO-8601 Z timestamps', async (repo) => {
  const slug = 'shape';
  const { skillId } = await repo.publish({ manifest: skill(slug, { tags: ['a-tag'], scan_flags: [{ rule: 'r' }] }), tarball: Buffer.from('t'), chunks: [content('x')] });
  await repo.publish({ manifest: skill('grand', { source: { kind: 'local' }, commit_sha: null, sha256: sha('2'), review_notes: GF }), tarball: Buffer.from('g'), chunks: [content('g')] });
  await repo.markUpstream(skillId, commit('b'), true);
  const rows = [
    await repo.getSkill(slug),
    ...(await repo.getSkillsByIds([skillId])),
    await repo.getTarball(slug),
    ...(await repo.listVersions(slug)),
    ...(await repo.listReviews(slug)),
    ...(await repo.listUpdates({})),
    ...(await repo.listUpdates({ grandfathered: true })),
    ...(await repo.listUpstreamTargets()),
  ];
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(Object.getPrototypeOf(row), Object.prototype, JSON.stringify(row));
    for (const key of ['update_available', 'current']) if (key in row) assert.equal(typeof row[key], 'boolean', key);
    if ('tags' in row) assert.ok(Array.isArray(row.tags));
    if ('scan_flags' in row) assert.ok(Array.isArray(row.scan_flags));
    for (const key of ['reviewed_at', 'checked_at']) if (key in row) assert.match(row[key], ISO, key);
  }
  assert.equal((await repo.getSkill(slug)).update_available, true);
  assert.deepEqual((await repo.getSkill(slug)).scan_flags, [{ rule: 'r' }]);
});

sqliteIt('a query made only of punctuation, one character or FTS syntax returns [] without throwing', async (repo) => {
  await repo.publish({ manifest: skill('quokka', { description: 'Export a video' }), tarball: Buffer.from('q'), chunks: [content('body text')] });
  for (const q of ['"', '*', '-', 'NEAR', 'AND', 'a', '" OR *', 'NEAR(a b)', '^x', '']) {
    assert.deepEqual(await repo.searchText(q, 10), [], JSON.stringify(q));
  }
});

sqliteIt('an accented query matches text written without accents and the reverse', async (repo) => {
  const plain = await repo.publish({ manifest: skill('plain', { description: 'Handles currency conversion' }), tarball: Buffer.from('p'), chunks: [content('x')] });
  const accented = await repo.publish({ manifest: skill('accented', { description: 'Gestiona la conversión de monedas', sha256: sha('2') }), tarball: Buffer.from('a'), chunks: [content('y')] });
  assert.ok((await repo.searchText('conversión', 10)).includes(plain.skillId));
  assert.ok((await repo.searchText('conversion', 10)).includes(accented.skillId));
});

sqliteIt('the body of the current approved version is searchable and replaced by the next approved one', async (repo) => {
  const { skillId } = await repo.publish({ manifest: skill('bodied'), tarball: Buffer.from('1'), chunks: [content('zeppelin manual'), { text: 'pelican question', kind: 'query', embedding: vec(1) }] });
  assert.deepEqual(await repo.searchText('zeppelin', 10), [skillId]);
  assert.deepEqual(await repo.searchText('pelican', 10), [], 'query chunks are not body text');
  await repo.publish({ manifest: skill('bodied', { sha256: sha('2'), status: 'rejected' }), tarball: null, chunks: [content('gondola')] });
  assert.deepEqual(await repo.searchText('gondola', 10), [], 'a rejected publish leaves the document alone');
  await repo.publish({ manifest: skill('bodied', { sha256: sha('3') }), tarball: Buffer.from('3'), chunks: [content('gondola')] });
  assert.deepEqual(await repo.searchText('gondola', 10), [skillId]);
  assert.deepEqual(await repo.searchText('zeppelin', 10), []);
});

const CHILD = `
import { runtimeCheck } from ${JSON.stringify(new URL('../../lib/local/runtime.mjs', import.meta.url).href)};
import { isBusy, openVault } from ${JSON.stringify(new URL('../../lib/local/schema.mjs', import.meta.url).href)};
import { createSqliteRepo } from ${JSON.stringify(new URL('../../lib/local/sqlite-repo.mjs', import.meta.url).href)};
const [dir, slug] = process.argv.slice(-2);
try {
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  for (let i = 0; i < 20; i++) {
    await repo.publish({
      manifest: { slug, name: slug, description: 'a concurrent writer', kind: 'skill', tags: [], source: { kind: 'local' },
        sha256: i.toString(16).padStart(64, '0'), status: 'approved', scan_flags: [] },
      tarball: Buffer.from(slug + i), chunks: [{ text: 'body ' + i }],
    });
  }
  db.close();
  console.log('ok');
} catch (e) {
  if (!isBusy(e)) throw e;
  console.log('vault is busy');
  process.exitCode = 3;
}
`;

function runChild(dir, slug) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, dir, slug], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ slug, code, stdout, stderr }));
  });
}

localTest('sqlite: two processes publishing to one vault at once both finish or report busy, and the vault stays intact', async () => {
  const dir = path.join(await tempDir('sv-concurrent-'), 'state');
  const results = await Promise.all([runChild(dir, 'writer-one'), runChild(dir, 'writer-two')]);
  for (const r of results) {
    assert.equal(r.stderr, '', `${r.slug} wrote to stderr`);
    assert.ok((r.code === 0 && r.stdout.trim() === 'ok') || r.stdout.includes('vault is busy'), JSON.stringify(r));
  }
  const db = openVault({ dir, DatabaseSync });
  try {
    assert.equal({ ...db.prepare('PRAGMA integrity_check').get() }.integrity_check, 'ok');
    const repo = createSqliteRepo(db);
    for (const r of results.filter((x) => x.code === 0)) {
      assert.ok(await repo.getSkill(r.slug), `${r.slug} reported success`);
      assert.equal((await repo.listVersions(r.slug)).length, 20);
    }
  } finally {
    db.close();
  }
});
