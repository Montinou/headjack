import assert from 'node:assert/strict';
import path from 'node:path';
import { localTest } from '../local-helpers.mjs';
import { tempDir, file } from '../helpers.mjs';
import { createLocalApi } from '../../lib/local/api.mjs';
import { ApiError } from '../../cli/api.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { checkLocalUpdates } from '../../lib/local/updates.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { pack } from '../../lib/tar.mjs';

const HOUR = 3_600_000;
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

// A published skill whose source is a GitHub repository (repo root, so the check compares commit trees).
function skill(slug, { url = `https://github.com/acme/${slug}`, commit_sha = OLD, description = `${slug} tool` } = {}) {
  const files = [file('SKILL.md', `---\nname: ${slug}\ndescription: ${description}\n---\n# Use\nRun ${slug}.`)];
  const manifest = {
    slug, name: slug, description, kind: 'skill', tags: [], sha256: hashFiles(files), status: 'approved',
    review_notes: 'ok', scan_flags: [], chunks: [`${slug}: ${description}`],
    source: { kind: 'github', url, default_ref: 'main' }, ...(commit_sha ? { commit_sha } : {}),
  };
  return { manifest, tarball: pack(files) };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// GitHub API stub: HEAD of main is NEW (tree t2); the reviewed commit OLD has tree t1. Records every URL asked.
function githubStub({ failFor = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (failFor.some((repo) => String(url).includes(`/repos/acme/${repo}/`))) throw new TypeError('fetch failed');
    if (String(url).includes(`/commits/${OLD}`)) return json({ sha: OLD, commit: { tree: { sha: 't1' } } });
    if (String(url).includes('/commits/main')) return json({ sha: NEW, commit: { tree: { sha: 't2' } } });
    return json({ message: 'not found' }, 404);
  };
  return { fetchImpl, calls };
}

localTest('api.updates() checks a stale target and returns the newer upstream commit', async () => {
  const dir = await tempDir('sv-local-upd-');
  const stub = githubStub();
  const { api, close } = await createLocalApi({ env: {}, dir, upstreamFetch: stub.fetchImpl, now: () => Date.now() + 7 * HOUR });
  try {
    const { manifest, tarball } = skill('alpha');
    await api.publish(manifest, tarball);
    const updates = await api.updates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].slug, 'alpha');
    assert.equal(updates[0].latest_commit, NEW);
    assert.equal(updates[0].reviewed_commit, OLD);
    assert.ok(stub.calls.length > 0);
  } finally {
    close();
  }
});

localTest('a target with no commit_sha is skipped and upstream is not called', async () => {
  const dir = await tempDir('sv-local-upd-');
  const stub = githubStub();
  const { api, repo, close } = await createLocalApi({ env: {}, dir });
  try {
    const { manifest, tarball } = skill('imported', { commit_sha: null });
    await api.publish(manifest, tarball);
    const result = await checkLocalUpdates({ repo, fetchImpl: stub.fetchImpl, now: () => Date.now() + 7 * HOUR });
    assert.deepEqual(result, { checked: 0, skipped: 1, failed: 0 });
    assert.deepEqual(stub.calls, []);
  } finally {
    close();
  }
});

localTest('a target checked an hour ago is skipped, and HEADJACK_UPDATE_TTL_HOURS=0 checks it', async () => {
  const dir = await tempDir('sv-local-upd-');
  const stub = githubStub();
  const later = () => Date.now() + HOUR;
  const first = await createLocalApi({ dir, upstreamFetch: stub.fetchImpl, env: {}, now: later });
  try {
    const { manifest, tarball } = skill('beta');
    await first.api.publish(manifest, tarball);
    assert.deepEqual(await first.api.updates(), []);
    assert.deepEqual(stub.calls, [], 'inside the six-hour window: no upstream call');
  } finally {
    first.close();
  }
  const second = await createLocalApi({ dir, upstreamFetch: stub.fetchImpl, env: { HEADJACK_UPDATE_TTL_HOURS: '0' }, now: later });
  try {
    const updates = await second.api.updates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].latest_commit, NEW);
  } finally {
    second.close();
  }
});

localTest('an upstream that throws for one target does not stop the other', async () => {
  const dir = await tempDir('sv-local-upd-');
  const stub = githubStub({ failFor: ['offline'] });
  const { api, repo, close } = await createLocalApi({ env: {}, dir, upstreamFetch: stub.fetchImpl, now: () => Date.now() + 7 * HOUR });
  try {
    for (const slug of ['offline', 'online']) {
      const { manifest, tarball } = skill(slug);
      await api.publish(manifest, tarball);
    }
    const result = await checkLocalUpdates({ repo, fetchImpl: stub.fetchImpl, now: () => Date.now() + 7 * HOUR });
    assert.deepEqual(result, { checked: 1, skipped: 0, failed: 1 });
    const updates = await api.updates();
    assert.deepEqual(updates.map((u) => u.slug), ['online']);
  } finally {
    close();
  }
});

localTest('api.updates() resolves when every upstream call fails', async () => {
  const dir = await tempDir('sv-local-upd-');
  const stub = githubStub({ failFor: ['gamma'] });
  const { api, close } = await createLocalApi({ env: {}, dir, upstreamFetch: stub.fetchImpl, now: () => Date.now() + 7 * HOUR });
  try {
    const { manifest, tarball } = skill('gamma');
    await api.publish(manifest, tarball);
    assert.deepEqual(await api.updates(), []);
  } finally {
    close();
  }
});

localTest('api.updates(true) (grandfathered) does not call upstream', async () => {
  const dir = await tempDir('sv-local-upd-');
  const stub = githubStub();
  const { api, close } = await createLocalApi({ env: {}, dir, upstreamFetch: stub.fetchImpl, now: () => Date.now() + 7 * HOUR });
  try {
    const { manifest, tarball } = skill('delta');
    await api.publish(manifest, tarball);
    assert.deepEqual(await api.updates(true), []);
    assert.deepEqual(stub.calls, []);
  } finally {
    close();
  }
});

// A busy lock is the one per-target failure that must not read as "up to date": the answer would be wrong, not just late.
localTest('checkLocalUpdates rethrows a busy-lock error from markUpstream and still counts other failures', async () => {
  const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  const target = { skill_id: 1, kind: 'github', url: 'https://github.com/acme/alpha', default_ref: 'main', commit_sha: OLD, source_path: null, checked_at: null };
  const stub = githubStub();
  const repoWith = (markUpstream) => ({ listUpstreamTargets: async () => [target], markUpstream });
  await assert.rejects(
    checkLocalUpdates({ repo: repoWith(async () => { throw busy; }), fetchImpl: stub.fetchImpl }),
    (e) => e === busy,
  );
  const other = new Error('disk I/O error');
  assert.deepEqual(
    await checkLocalUpdates({ repo: repoWith(async () => { throw other; }), fetchImpl: stub.fetchImpl }),
    { checked: 0, skipped: 0, failed: 1 },
  );
});

localTest('api.updates() answers 503 unavailable when another connection holds the write lock', async () => {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-local-upd-');
  const stub = githubStub();
  // The vault's own 5 s busy_timeout would make this test wait 5 s; shorten it for the one connection opened here.
  const realExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function exec(sql) {
    return realExec.call(this, sql === 'PRAGMA busy_timeout = 5000' ? 'PRAGMA busy_timeout = 50' : sql);
  };
  let created;
  try {
    created = await createLocalApi({ dir, env: {}, upstreamFetch: stub.fetchImpl, now: () => Date.now() + 7 * HOUR });
  } finally {
    DatabaseSync.prototype.exec = realExec;
  }
  const { api, close } = created;
  const holder = new DatabaseSync(path.join(dir, 'vault.db'));
  try {
    const { manifest, tarball } = skill('busy-one');
    await api.publish(manifest, tarball);
    holder.exec('PRAGMA busy_timeout = 50');
    holder.exec('BEGIN IMMEDIATE');
    await assert.rejects(
      api.updates(),
      (e) => e instanceof ApiError && e.status === 503 && e.code === 'unavailable' && e.message === 'vault is busy, try again',
    );
    assert.ok(stub.calls.length > 0, 'upstream was asked, so the failure came from recording the answer');
    holder.exec('ROLLBACK');
    const updates = await api.updates();
    assert.deepEqual(updates.map((u) => u.slug), ['busy-one'], 'once the lock is gone the same call reports the update');
  } finally {
    if (holder.isTransaction) holder.exec('ROLLBACK');
    holder.close();
    close();
  }
});
