import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { localTest, zeroPagesAfterFirst } from '../local-helpers.mjs';
import { tempDir, file } from '../helpers.mjs';
import { createLocalApi } from '../../lib/local/api.mjs';
import { ApiError } from '../../cli/api.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { pack } from '../../lib/tar.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { isBusy, openVault, vaultFile } from '../../lib/local/schema.mjs';

const files = [file('SKILL.md', '---\nname: zebra-tool\ndescription: Tracks zebra migrations\n---\n# Use\nCount zebras.')];
const manifest = {
  slug: 'zebra-tool', name: 'zebra-tool', description: 'Tracks zebra migrations', kind: 'skill', tags: ['wildlife'],
  source: { kind: 'local' }, sha256: hashFiles(files), status: 'approved', review_notes: 'ok', scan_flags: [],
  chunks: ['zebra-tool: Tracks zebra migrations', 'Count zebras.'],
};
const URL_BASE = 'http://headjack.local';

// The real busy error: a second connection writing while the first holds BEGIN IMMEDIATE.
async function realBusyError() {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-busy-');
  const first = openVault({ dir, DatabaseSync });
  const second = new DatabaseSync(`${dir}/vault.db`);
  second.exec('PRAGMA busy_timeout = 50');
  first.exec('BEGIN IMMEDIATE');
  try {
    second.exec("insert into sources (kind, url) values ('local', null)");
  } catch (e) {
    return e;
  } finally {
    first.exec('ROLLBACK');
    second.close();
    first.close();
  }
  throw new Error('expected a busy error');
}

localTest('the in-process api publishes, searches, reads, downloads and lists versions and reviews', async () => {
  const dir = await tempDir('sv-local-api-');
  const { api, route, close } = await createLocalApi({ dir });
  try {
    const published = await api.publish(manifest, pack(files));
    assert.equal(typeof published.skillId, 'number');

    const results = await api.search('zebra');
    assert.equal(results.length, 1);
    assert.equal(results[0].slug, 'zebra-tool');
    assert.equal(results[0].update_available, false);

    const skill = await api.getSkill('zebra-tool');
    assert.equal(skill.slug, 'zebra-tool');
    assert.equal(skill.sha256, manifest.sha256);
    assert.equal(await api.getSkill('nope'), null);

    const dl = await api.download('zebra-tool');
    assert.equal(dl.sha256, manifest.sha256);
    assert.deepEqual(dl.tarball, pack(files));

    const versions = await api.versions('zebra-tool');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].current, true);
    const reviews = await api.reviews('zebra-tool');
    assert.equal(reviews[0].status, 'approved');

    assert.deepEqual(await api.updates(), []);
    assert.equal(await api.installEvent({ slug: 'zebra-tool', kind: 'skill', source: 'manual' }), undefined);

    const posted = await route(`${URL_BASE}/api/search`, { method: 'POST', body: JSON.stringify({ q: 'zebra' }) });
    assert.equal(posted.status, 200);
    assert.deepEqual((await posted.json()).results.map((r) => r.slug), ['zebra-tool']);
    assert.equal((await route(`${URL_BASE}/api/search`, { method: 'PUT', body: '{}' })).status, 404);

    assert.equal((await route(`${URL_BASE}/api/unknown`, {})).status, 404);
    assert.equal((await route(`${URL_BASE}/api/skills/zebra-tool/other`, {})).status, 404);
  } finally {
    close();
  }
});

localTest('publishing the same version twice answers 409 conflict', async () => {
  const dir = await tempDir('sv-local-api-');
  const { api, close } = await createLocalApi({ dir });
  try {
    await api.publish(manifest, pack(files));
    await assert.rejects(api.publish(manifest, pack(files)), (e) => e instanceof ApiError && e.status === 409);
  } finally {
    close();
  }
});

localTest('a busy vault is a 503 unavailable ApiError and nothing is printed to stderr', async () => {
  const dir = await tempDir('sv-local-api-');
  const busy = await realBusyError();
  assert.equal(isBusy(busy), true);
  const { api, close } = await createLocalApi({
    dir,
    wrapRepo: (repo) => ({ ...repo, searchText: async () => { throw busy; } }),
  });
  const written = [];
  const origErr = console.error;
  const origWrite = process.stderr.write;
  console.error = (...a) => written.push(a.join(' '));
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    await assert.rejects(api.search('zebra'), (e) => e instanceof ApiError && e.status === 503 && e.code === 'unavailable' && e.message === 'vault is busy, try again');
  } finally {
    console.error = origErr;
    process.stderr.write = origWrite;
    close();
  }
  assert.deepEqual(written, []);
});

localTest('a damaged vault is a 4xx "is damaged; run headjack verify" ApiError, from search and from updates, with no stderr output', async () => {
  const dir = await tempDir('sv-local-api-');
  const first = await createLocalApi({ dir, env: {} });
  await first.api.publish(manifest, pack(files));
  first.close();
  await zeroPagesAfterFirst(vaultFile(dir));
  const { api, close } = await createLocalApi({ dir, env: {} });
  const written = [];
  const origErr = console.error;
  const origWrite = process.stderr.write;
  console.error = (...a) => written.push(a.join(' '));
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  const damaged = (e) => e instanceof ApiError && e.status >= 400 && e.status < 500 && e.message === `vault ${vaultFile(dir)} is damaged; run headjack verify`;
  try {
    await assert.rejects(api.search('zebra'), damaged);
    // The upstream pre-check reads the vault too; with a stale target it would otherwise surface the raw error (exit 1).
    await assert.rejects(api.updates(), damaged);
    await assert.rejects(api.updates(true), damaged);
  } finally {
    console.error = origErr;
    process.stderr.write = origWrite;
    close();
  }
  assert.deepEqual(written, []);
});

// A closed last connection removes the -wal file; an open one leaves it.
const walOf = (dir) => `${dir}/vault.db-wal`;
const exists = (p) => access(p).then(() => true, () => false);

localTest('close() can be called twice', async () => {
  const dir = await tempDir('sv-local-api-');
  const { close } = await createLocalApi({ dir });
  close();
  assert.doesNotThrow(() => close());
});

localTest('close() releases the vault file', async () => {
  const dir = await tempDir('sv-local-api-');
  const { close } = await createLocalApi({ dir });
  assert.equal(await exists(walOf(dir)), true);
  close();
  assert.equal(await exists(walOf(dir)), false);
});

localTest('a build that fails after the vault opened closes the database', async () => {
  const dir = await tempDir('sv-local-api-');
  const env = { get CLAUDE_CODE_SESSION_ID() { throw new Error('boom'); } };
  await assert.rejects(createLocalApi({ dir, env }), /boom/);
  assert.equal(await exists(walOf(dir)), false);
});

localTest('the in-process api lists published skills with kind and tag filters and pages them', async () => {
  const dir = await tempDir('sv-local-api-');
  const { api, route, close } = await createLocalApi({ dir });
  try {
    const publish = async (slug, kind, tags, status = 'approved') => {
      const f = [file('SKILL.md', `---\nname: ${slug}\ndescription: the ${slug}\n---\n# ${slug}`)];
      await api.publish({
        slug, name: slug, description: `the ${slug}`, kind, tags, source: { kind: 'local' }, sha256: hashFiles(f), status,
        review_notes: 'ok', scan_flags: [], chunks: [`${slug}: the ${slug}`],
      }, pack(f));
    };
    assert.deepEqual(await api.list(), { skills: [], total: 0, limit: 50, offset: 0 });
    await publish('cherry', 'skill', ['fruit', 'red']);
    await publish('apple', 'skill', ['fruit', 'red']);
    await publish('banana', 'skill', ['fruit']);
    await publish('toolbox', 'plugin', ['tools']);

    const all = await api.list();
    assert.deepEqual(all.skills.map((s) => s.slug), ['apple', 'banana', 'cherry', 'toolbox']);
    assert.deepEqual([all.total, all.limit, all.offset], [4, 50, 0]);
    assert.deepEqual(Object.keys(all.skills[0]).sort(), [
      'description', 'has_approved_version', 'kind', 'name', 'plugin_slug', 'quality', 'slug', 'tags', 'update_available',
    ]);
    assert.equal(all.skills[0].has_approved_version, true);

    assert.deepEqual((await api.list({ kind: 'plugin' })).skills.map((s) => s.slug), ['toolbox']);
    assert.deepEqual((await api.list({ tag: ['fruit', 'red'] })).skills.map((s) => s.slug), ['apple', 'cherry']);
    assert.deepEqual((await api.list({ tag: 'fruit', kind: 'plugin' })), { skills: [], total: 0, limit: 50, offset: 0 });

    const page = await api.list({ limit: 2, offset: 1 });
    assert.deepEqual(page.skills.map((s) => s.slug), ['banana', 'cherry']);
    assert.deepEqual([page.total, page.limit, page.offset], [4, 2, 1]);

    await assert.rejects(api.list({ kind: 'bogus' }), (e) => e instanceof ApiError && e.status === 400);
    assert.equal((await route(`${URL_BASE}/api/skills`, { method: 'DELETE' })).status, 404);
  } finally {
    close();
  }
});

localTest('search results carry a review status and never review_notes', async () => {
  const dir = await tempDir('sv-local-review-');
  const { api, close } = await createLocalApi({ dir });
  try {
    const grand = [file('SKILL.md', '---\nname: okapi-old\ndescription: Tracks okapi sightings\n---\n# Use\nCount okapis.')];
    const rev = [file('SKILL.md', '---\nname: okapi-new\ndescription: Tracks okapi sightings\n---\n# Use\nCount okapis.')];
    const mk = (slug, files, review_notes) => ({
      slug, name: slug, description: 'Tracks okapi sightings', kind: 'skill', tags: [], source: { kind: 'local' },
      sha256: hashFiles(files), status: 'approved', review_notes, scan_flags: [], chunks: [`${slug}: Tracks okapi sightings`, 'Count okapis.'],
    });
    await api.publish(mk('okapi-old', grand, 'grandfathered: installed before the vault, not reviewed'), pack(grand));
    await api.publish(mk('okapi-new', rev, 'reviewed by hand'), pack(rev));
    const results = await api.search('okapi');
    const by = Object.fromEntries(results.map((r) => [r.slug, r]));
    assert.equal(by['okapi-old'].review, 'unreviewed');
    assert.equal(by['okapi-new'].review, 'approved');
    assert.ok(results.every((r) => !('review_notes' in r)));
  } finally {
    close();
  }
});
