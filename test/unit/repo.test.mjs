import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepo, repoForOwner, REPO_METHODS } from '../../lib/repo.mjs';
import { ConflictError } from '../../lib/errors.mjs';
import { ENRICHMENT_VERSION } from '../../lib/enrich-prompt.mjs';

// Fake transaction handle (what withOwner passes to createRepo): records every query(text, params) and answers
// via `respond(text, params)`; app.put_blob answers a fixed hash unless `respond` does. Transactions, rollback and
// client release belong to withOwner (test/unit/db.test.mjs).
const BLOB_SHA = 'b'.repeat(64);
function fakePool(respond = () => []) {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    const rows = (await respond(text, params)) ?? [];
    if (!rows.length && text.startsWith('select app.put_blob')) return { rows: [{ sha256: BLOB_SHA }] };
    return { rows };
  };
  return { calls, query };
}

// The highest $n in the SQL must equal params.length for every query.
function assertPlaceholders(calls) {
  for (const { text, params } of calls) {
    const nums = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const max = nums.length ? Math.max(...nums) : 0;
    assert.equal(max, (params ?? []).length, `placeholder/param mismatch in: ${text}`);
  }
}

const sql = (calls) => calls.map((c) => c.text.trim());

const manifest = {
  slug: 's', name: 'n', description: 'd', kind: 'skill', tags: ['t'],
  source: { kind: 'github', url: 'https://github.com/x/y' }, source_path: 'skills/s',
  commit_sha: 'a'.repeat(40), sha256: '1'.repeat(64), status: 'approved', review_notes: 'ok', scan_flags: [],
};

test('publish runs on the transaction it is given and never opens or ends one itself', async () => {
  const pool = fakePool((text) => (/returning id/.test(text) ? [{ id: '5' }] : []));
  const repo = createRepo(pool);
  const out = await repo.publish({
    manifest, tarball: Buffer.from('tgz'),
    chunks: [{ text: 'a', embedding: [1, 0] }, { text: 'b', embedding: [0, 1] }],
  });
  assert.deepEqual(out, { skillId: 5, versionId: 5 });
  const texts = sql(pool.calls);
  assert.ok(!texts.some((t) => /^(begin|commit|rollback)$/.test(t)));
  assert.match(texts[0], /^insert into sources/);
  assert.match(texts.at(-1), /^insert into upstream/);
  const chunkInserts = pool.calls.filter((c) => c.text.startsWith('insert into chunks'));
  assert.deepEqual(chunkInserts.map((c) => c.params[3]), ['[1,0]', '[0,1]']);
  assertPlaceholders(pool.calls);
});

test('publish throws ConflictError on a duplicate (slug, sha256) before writing a version', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('select id from skills')) return [{ id: '7' }];
    if (text.startsWith('select 1 from versions')) return [{ '?column?': 1 }];
    if (/returning id/.test(text)) return [{ id: '3' }];
    return [];
  });
  const repo = createRepo(pool);
  await assert.rejects(repo.publish({ manifest, tarball: null, chunks: [] }), ConflictError);
  const texts = sql(pool.calls);
  assert.ok(!texts.some((t) => t.startsWith('insert into versions') || t.startsWith('update skills')));
  assertPlaceholders(pool.calls);
});

test('markUpstream stores the update_available decision it is given', async () => {
  const pool = fakePool();
  const repo = createRepo(pool);
  await repo.markUpstream(1, 'b'.repeat(40), false);
  await repo.markUpstream(1, 'b'.repeat(40), true);
  await repo.markUpstream(1, 'a'.repeat(40), false);
  assert.deepEqual(pool.calls.map((c) => c.params), [[1, 'b'.repeat(40), false], [1, 'b'.repeat(40), true], [1, 'a'.repeat(40), false]]);
  assertPlaceholders(pool.calls);
});

test('listUpstreamTargets selects the skill source_path', async () => {
  const pool = fakePool();
  await createRepo(pool).listUpstreamTargets();
  assert.match(pool.calls[0].text, /\bs\.source_path\b/);
});

test('listUpstreamTargets baselines commit_sha on the latest reviewed version, not current_version_id', async () => {
  const pool = fakePool();
  await createRepo(pool).listUpstreamTargets();
  assert.doesNotMatch(pool.calls[0].text, /join versions v on v\.id = s\.current_version_id/);
  assert.match(pool.calls[0].text, /order by reviewed_at desc, id desc/);
});

test('listUpstreamTargets only picks a baseline commit that is not null, and only tracks skills with a current approved version', async () => {
  const pool = fakePool();
  await createRepo(pool).listUpstreamTargets();
  assert.match(pool.calls[0].text, /commit_sha is not null/, 'a commit-less rejected review must never become the baseline');
  assert.match(pool.calls[0].text, /s\.current_version_id is not null/, 'a skill with only rejected versions is not an upstream target');
});

test('listUpdates also only baselines reviewed_commit on a version that has a commit_sha', async () => {
  const pool = fakePool();
  await createRepo(pool).listUpdates({});
  assert.match(pool.calls[0].text, /commit_sha is not null/);
});

test('listReviews orders reviews newest first and marks which one is current, owner-scoped like every query', async () => {
  const pool = fakePool();
  await createRepo(pool).listReviews('s');
  assert.match(pool.calls[0].text, /order by v\.reviewed_at desc, v\.id desc/);
  assert.match(pool.calls[0].text, /coalesce\(v\.id = s\.current_version_id, false\) as current/);
  assert.match(pool.calls[0].text, /v\.commit_sha, v\.status, v\.reviewed_at, v\.review_notes, v\.sha256/);
  assert.deepEqual(pool.calls[0].params, ['s']);
  assertPlaceholders(pool.calls);
});

test('searchVector serializes the embedding and returns { id, sim } rows of Numbers', async () => {
  const pool = fakePool(() => [{ skill_id: '3', sim: '0.9' }, { skill_id: '1', sim: 0.5 }]);
  const repo = createRepo(pool);
  assert.deepEqual(await repo.searchVector([0.5, 1, -2], 5), [{ id: 3, sim: 0.9 }, { id: 1, sim: 0.5 }]);
  assert.deepEqual(pool.calls[0].params, ['[0.5,1,-2]', 5]);
  assertPlaceholders(pool.calls);
});

test('every query has matching placeholder and param counts', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('select id from skills')) return [{ id: '7' }];
    if (/returning id/.test(text)) return [{ id: '9' }];
    return [];
  });
  const repo = createRepo(pool);
  await repo.searchText('remotion', 5);
  await repo.searchText('convertir pdf', 5, [], { bilingual: true });
  await repo.searchText('convertir pdf', 5, ['docs'], { bilingual: true });
  await repo.searchText('quiero hacer', 5, ['docs'], { bilingual: true });
  await repo.getSkillsByIds([1, 2]);
  assert.deepEqual(await repo.getSkillsByIds([]), []);
  assert.equal(await repo.getSkill('nope'), null);
  assert.equal(await repo.getTarball('nope'), null);
  await repo.listVersions('s');
  await repo.listUpdates({});
  await repo.listUpdates({ grandfathered: true });
  await repo.listUpstreamTargets();
  await repo.listReviews('s');
  await repo.publish({ manifest, tarball: Buffer.from('x'), chunks: [{ text: 'a', embedding: [1] }] });
  await repo.publish({ manifest: { ...manifest, source: undefined, status: 'rejected', sha256: '2'.repeat(64) }, tarball: null, chunks: [] });
  assert.ok(pool.calls.length > 15);
  assertPlaceholders(pool.calls);
});

test('listVersions returns current as a strict boolean even when no version is current', async () => {
  const pool = fakePool();
  const repo = createRepo(pool);
  await repo.listVersions('s');
  assert.match(pool.calls[0].text, /coalesce\(v\.id = s\.current_version_id, false\) as current/);
  assertPlaceholders(pool.calls);
});

test("publish of a rejected version resets that skill's upstream notice immediately, without waiting for the next cron", async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('select id from skills')) return [{ id: '11' }];
    if (/returning id/.test(text)) return [{ id: '5' }];
    return [];
  });
  const repo = createRepo(pool);
  const out = await repo.publish({ manifest: { ...manifest, status: 'rejected' }, tarball: null, chunks: [] });
  assert.equal(out.skillId, 11);
  const reset = pool.calls.find((c) => c.text.startsWith('update upstream set update_available = false'));
  assert.ok(reset, "a rejected publish must reset the skill's upstream notice");
  assert.deepEqual(reset.params, ['11']);
  assertPlaceholders(pool.calls);
});

test('publish maps a unique_violation (23505) to ConflictError', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('insert into skills')) throw Object.assign(new Error('duplicate key value violates unique constraint "skills_owner_id_slug_key"'), { code: '23505' });
    if (/returning id/.test(text)) return [{ id: '3' }];
    return [];
  });
  const repo = createRepo(pool);
  await assert.rejects(repo.publish({ manifest, tarball: null, chunks: [] }), ConflictError);
  assert.match(sql(pool.calls).at(-1), /^insert into skills/, 'nothing runs after the failed statement');
});

test('publish rethrows other database errors unchanged', async () => {
  const boom = Object.assign(new Error('connection reset'), { code: '08006' });
  const pool = fakePool((text) => {
    if (text.startsWith('insert into skills')) throw boom;
    if (/returning id/.test(text)) return [{ id: '3' }];
    return [];
  });
  const repo = createRepo(pool);
  await assert.rejects(repo.publish({ manifest, tarball: null, chunks: [] }), (e) => e === boom);
  assert.match(sql(pool.calls).at(-1), /^insert into skills/, 'nothing runs after the failed statement');
});

// --- Final fix wave ---

test('searchText ORs the words of the query into an english to_tsquery', async () => {
  const pool = fakePool(() => [{ id: '4' }]);
  const repo = createRepo(pool);
  assert.deepEqual(await repo.searchText("Review my UI (web) & it's canción!", 50), [4]);
  const [call] = pool.calls;
  assert.match(call.text, /fts @@ to_tsquery\('english', \$1\)/);
  assert.match(call.text, /ts_rank\(fts, to_tsquery\('english', \$1\)\)/);
  assert.doesNotMatch(call.text, /'simple'/);
  assert.doesNotMatch(call.text, /plainto_tsquery/);
  assert.deepEqual(call.params, ['Review | my | UI | web | it | canción', 50]);
  assertPlaceholders(pool.calls);
});

test('searchText drops terms shorter than 2 characters and skips the query when only those remain', async () => {
  const pool = fakePool(() => []);
  const repo = createRepo(pool);
  await repo.searchText('a b make 3d x models', 50);
  assert.equal(pool.calls[0].params[0], 'make | 3d | models');
  assert.deepEqual(await repo.searchText('a b-c 7', 50), []);
  assert.equal(pool.calls.length, 1, 'no query when every term is a single character');
});

test('searchText caps the query at 20 terms and skips the query when there are none', async () => {
  const pool = fakePool(() => []);
  const repo = createRepo(pool);
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
  await repo.searchText(words.join(' '), 50);
  assert.equal(pool.calls[0].params[0], words.slice(0, 20).join(' | '));
  assert.deepEqual(await repo.searchText(' !!! ** ', 50), []);
  assert.equal(pool.calls.length, 1, 'no query without terms');
});

test('searchText with bilingual false (the default) sends exactly the english-only query', async () => {
  const pool = fakePool(() => [{ id: '4' }]);
  const repo = createRepo(pool);
  await repo.searchText('convertir pdf', 50, ['docs']);
  await repo.searchText('convertir pdf', 50, ['docs'], { bilingual: false });
  const [dflt, off] = pool.calls;
  assert.equal(off.text, dflt.text);
  assert.deepEqual(off.params, dflt.params);
  assert.doesNotMatch(off.text, /fts_es|spanish|greatest/);
  assert.deepEqual(off.params, ['convertir | pdf', 50, ['docs']]);
});

test('searchText with bilingual ORs an english and a spanish match and ranks by the greater ts_rank', async () => {
  const pool = fakePool(() => [{ id: '8' }, { id: '3' }]);
  const repo = createRepo(pool);
  assert.deepEqual(await repo.searchText('Quiero convertir un PDF, cómo', 50, [], { bilingual: true }), [8, 3]);
  const [call] = pool.calls;
  assert.match(call.text, /fts @@ to_tsquery\('english', \$1\) or fts_es @@ to_tsquery\('spanish', \$2\)/);
  assert.match(call.text, /greatest\(ts_rank\(fts, to_tsquery\('english', \$1\)\), ts_rank\(fts_es, to_tsquery\('spanish', \$2\)\)\)/);
  assert.match(call.text, /current_version_id is not null/);
  assert.deepEqual(call.params, ['Quiero | convertir | un | PDF | cómo', 'convertir | un | PDF', 50]);
  await repo.searchText('convertir pdf', 50, ['docs'], { bilingual: true });
  assert.match(pool.calls[1].text, /tags @> \$4::text\[\]/);
  assert.deepEqual(pool.calls[1].params, ['convertir | pdf', 'convertir | pdf', 50, ['docs']]);
  assertPlaceholders(pool.calls);
});

test('searchText with bilingual skips the spanish predicate when only filler words remain', async () => {
  const pool = fakePool(() => []);
  const repo = createRepo(pool);
  await repo.searchText('Quiero HACER, ¿cómo PUEDO?', 50, [], { bilingual: true });
  await repo.searchText('Quiero HACER, ¿cómo PUEDO?', 50);
  const [bi, en] = pool.calls;
  assert.doesNotMatch(bi.text, /fts_es|spanish/);
  assert.equal(bi.text, en.text);
  assert.deepEqual(bi.params, en.params);
});

test('listUpdates returns source_path so the CLI can print a precise review hint', async () => {
  const pool = fakePool();
  await createRepo(pool).listUpdates({});
  assert.match(pool.calls[0].text, /s\.source_path/);
});

test('listUpdates selects reviewed_commit (the baseline) alongside the current version\'s commit', async () => {
  const pool = fakePool();
  await createRepo(pool).listUpdates({});
  assert.match(pool.calls[0].text, /as reviewed_commit/);
  assert.match(pool.calls[0].text, /v\.commit_sha as current_commit/);
});

// --- Search enrichment ---

test('publish stores each chunk kind, defaulting to content', async () => {
  const pool = fakePool((text) => (/returning id/.test(text) ? [{ id: '5' }] : []));
  await createRepo(pool).publish({
    manifest, tarball: Buffer.from('x'),
    chunks: [{ text: 'a', embedding: [1] }, { text: 'q', embedding: [0], kind: 'query' }],
  });
  const inserts = pool.calls.filter((c) => c.text.startsWith('insert into chunks'));
  assert.match(inserts[0].text, /\(skill_id, version_id, text, embedding, kind\)/);
  assert.deepEqual(inserts.map((c) => c.params[4]), ['content', 'query']);
  assertPlaceholders(pool.calls);
});

test('publish stores tags and the space-joined tags_text on insert and on update', async () => {
  const fresh = fakePool((text) => (/returning id/.test(text) ? [{ id: '5' }] : []));
  await createRepo(fresh).publish({ manifest: { ...manifest, tags: ['audio', 'podcast-mastering'] }, tarball: null, chunks: [] });
  const ins = fresh.calls.find((c) => c.text.startsWith('insert into skills'));
  assert.match(ins.text, /tags, tags_text\)/);
  assert.deepEqual(ins.params.slice(-2), [['audio', 'podcast-mastering'], 'audio podcast-mastering']);
  assertPlaceholders(fresh.calls);

  const existing = fakePool((text) => {
    if (text.startsWith('select id from skills')) return [{ id: '7' }];
    if (/returning id/.test(text)) return [{ id: '3' }];
    return [];
  });
  await createRepo(existing).publish({ manifest: { ...manifest, tags: ['x'] }, tarball: null, chunks: [] });
  const upd = existing.calls.find((c) => c.text.startsWith('update skills set name'));
  assert.match(upd.text, /tags = \$8, tags_text = \$9/);
  assert.deepEqual(upd.params.slice(-2), [['x'], 'x']);
  assertPlaceholders(existing.calls);
});

test('listEnrichmentTargets lists current versions without query chunks, honoring force and only', async () => {
  const pool = fakePool(() => [{ skill_id: 3, version_id: 4, slug: 'a', name: 'a', description: 'd', kind: 'skill', plugin_slug: null, tags: [] }]);
  const repo = createRepo(pool);
  const rows = await repo.listEnrichmentTargets();
  assert.equal(rows[0].slug, 'a');
  await repo.listEnrichmentTargets({ force: true, only: ['a', 'b'] });
  const [first, second] = pool.calls;
  assert.match(first.text, /join versions v on v\.id = s\.current_version_id/);
  assert.match(first.text, /c\.kind = 'query'/);
  assert.doesNotMatch(first.text, /tarball/, 'tarballs are fetched one by one, not in the listing');
  assert.deepEqual(first.params, [false, []]);
  assert.deepEqual(second.params, [true, ['a', 'b']]);
  assertPlaceholders(pool.calls);
});

test('addQueryChunks replaces the version query chunks, tags and Spanish query text', async () => {
  const pool = fakePool((text) => (text.startsWith('select current_version_id') ? [{ current_version_id: '4' }] : []));
  const ok = await createRepo(pool).addQueryChunks({
    skillId: 3, versionId: 4, tags: ['audio', 'podcast'], queriesEs: ['q2', 'otra'],
    chunks: [{ text: 'q1', embedding: [1, 0] }, { text: 'q2', embedding: [0, 1] }],
  });
  assert.equal(ok, true);
  const texts = sql(pool.calls);
  assert.match(texts[0], /for update/);
  assert.match(texts[1], /^delete from chunks where skill_id = \$1 and version_id = \$2 and kind = 'query'/);
  const inserts = pool.calls.filter((c) => c.text.startsWith('insert into chunks'));
  assert.deepEqual(inserts.map((c) => [c.params[2], c.params[4]]), [['q1', 'query'], ['q2', 'query']]);
  const upd = pool.calls.find((c) => c.text.startsWith('update skills set tags'));
  assert.deepEqual(upd.params, [3, ['audio', 'podcast'], 'audio podcast', 'q2 otra', ENRICHMENT_VERSION]);
  assertPlaceholders(pool.calls);
});

test('addQueryChunks writes nothing when the version is no longer current', async () => {
  const pool = fakePool((text) => (text.startsWith('select current_version_id') ? [{ current_version_id: '9' }] : []));
  const ok = await createRepo(pool).addQueryChunks({ skillId: 3, versionId: 4, tags: [], chunks: [{ text: 'q', embedding: [1] }] });
  assert.equal(ok, false);
  const texts = sql(pool.calls);
  assert.ok(!texts.some((t) => t.startsWith('insert') || t.startsWith('delete') || t.startsWith('update')));
});

test('addQueryChunks propagates a failure so withOwner rolls the whole call back', async () => {
  const boom = new Error('insert failed');
  const pool = fakePool((text) => {
    if (text.startsWith('select current_version_id')) return [{ current_version_id: '4' }];
    if (text.startsWith('insert into chunks')) throw boom;
    return [];
  });
  await assert.rejects(createRepo(pool).addQueryChunks({ skillId: 3, versionId: 4, tags: [], chunks: [{ text: 'q', embedding: [1] }] }), (e) => e === boom);
  assert.ok(!sql(pool.calls).some((t) => t.startsWith('update skills')));
});

test('setAuditMetadata stores quality and merges suggested tags into tags and tags_text', async () => {
  const pool = fakePool((text) => (text.startsWith('select id, tags from skills') ? [{ id: '4', tags: ['audio', 'tts'] }] : []));
  const quality = { reuse: 3, trigger: 3, content: 2, health: 2, verdict: 'VAULT', audited_at: '2026-09-23T00:00:00.000Z' };
  assert.equal(await createRepo(pool).setAuditMetadata('text-to-speech', quality, ['TTS', 'ElevenLabs', 'voice']), true);
  const texts = sql(pool.calls);
  assert.match(texts[0], /where slug = \$1 for update/);
  const upd = pool.calls.find((c) => c.text.startsWith('update skills set quality'));
  assert.deepEqual(upd.params, ['4', JSON.stringify(quality), ['audio', 'tts', 'elevenlabs', 'voice'], 'audio tts elevenlabs voice']);
  assert.match(upd.text, /quality = \$2::jsonb/);
  assertPlaceholders(pool.calls);
});

test('setAuditMetadata returns false and writes nothing for a skill not in the vault', async () => {
  const pool = fakePool(() => []);
  assert.equal(await createRepo(pool).setAuditMetadata('nope', { reuse: 1 }, ['x']), false);
  const texts = sql(pool.calls);
  assert.ok(!texts.some((t) => t.startsWith('update')));
});

test('searchVector ranks by the best chunk of either kind (no kind filter) and getSkillsByIds returns tags and quality', async () => {
  const pool = fakePool(() => []);
  const repo = createRepo(pool);
  await repo.searchVector([1], 5);
  assert.match(pool.calls[0].text, /max\(1 - \(c\.embedding <=> \$1::vector\)\)/);
  assert.doesNotMatch(pool.calls[0].text, /kind/);
  await repo.getSkillsByIds([1]);
  assert.match(pool.calls[1].text, /s\.tags, s\.quality/);
  await repo.getSkill('x');
  assert.match(pool.calls[2].text, /s\.tags, s\.quality/);
});

test('searchVector and searchText require every requested tag, and leave the SQL alone without tags', async () => {
  const pool = fakePool(() => [{ skill_id: '2', id: '2', sim: 0.7 }]);
  const repo = createRepo(pool);
  assert.deepEqual(await repo.searchVector([1], 50, ['python', 'godot']), [{ id: 2, sim: 0.7 }]);
  assert.deepEqual(await repo.searchText('script', 50, ['python']), [2]);
  const [v, t] = pool.calls;
  assert.match(v.text, /s\.tags @> \$3::text\[\]/);
  assert.deepEqual(v.params, ['[1]', 50, ['python', 'godot']]);
  assert.match(t.text, /tags @> \$3::text\[\]/);
  assert.deepEqual(t.params, ['script', 50, ['python']]);
  await repo.searchVector([1], 50, []);
  await repo.searchText('script', 50);
  assert.doesNotMatch(pool.calls[2].text, /@>/);
  assert.deepEqual(pool.calls[3].params, ['script', 50]);
  assertPlaceholders(pool.calls);
});

test('versionExists checks (slug, sha256) with one read-only query and returns a boolean', async () => {
  const pool = fakePool((text, params) => (params[1] === '1'.repeat(64) ? [{ '?column?': 1 }] : []));
  const repo = createRepo(pool);
  assert.equal(await repo.versionExists('s', '1'.repeat(64)), true);
  assert.equal(await repo.versionExists('s', '2'.repeat(64)), false);
  assert.equal(pool.calls.length, 2);
  assert.deepEqual(pool.calls[0].params, ['s', '1'.repeat(64)]);
  assert.match(pool.calls[0].text, /^select\b/i);
  assert.match(pool.calls[0].text, /join skills s on s\.id = v\.skill_id/);
  assert.match(pool.calls[0].text, /s\.slug = \$1 and v\.sha256 = \$2/);
  assertPlaceholders(pool.calls);
});

// --- Multi-user foundation ---

test('publish stores the tarball through app.put_blob and points the version at the returned hash', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('select app.put_blob')) return [{ sha256: 'b'.repeat(64) }];
    return /returning id/.test(text) ? [{ id: '5' }] : [];
  });
  const tarball = Buffer.from('tgz bytes');
  await createRepo(pool).publish({ manifest, tarball, chunks: [] });
  const blob = pool.calls.find((c) => c.text.startsWith('select app.put_blob'));
  assert.deepEqual(blob.params, [tarball]);
  assert.ok(!pool.calls.some((c) => /insert into blobs/.test(c.text)), 'the app role never inserts into blobs directly');
  const version = pool.calls.find((c) => c.text.startsWith('insert into versions'));
  assert.match(version.text, /blob_sha256/);
  assert.doesNotMatch(version.text, /tarball/);
  assert.equal(version.params[3], 'b'.repeat(64));
  assert.equal(version.params[4], tarball.length, 'versions.size stays the tarball size');
  assert.ok(pool.calls.indexOf(blob) < pool.calls.indexOf(version), 'the blob exists before the version references it');
  assertPlaceholders(pool.calls);
});

test('publish without a tarball writes no blob and a null blob_sha256', async () => {
  const pool = fakePool((text) => (/returning id/.test(text) ? [{ id: '5' }] : []));
  await createRepo(pool).publish({ manifest: { ...manifest, status: 'rejected' }, tarball: null, chunks: [] });
  assert.ok(!pool.calls.some((c) => c.text.startsWith('select app.put_blob')));
  assert.equal(pool.calls.find((c) => c.text.startsWith('insert into versions')).params[3], null);
});

test('sources are unique per owner and no statement names owner_id as a value', async () => {
  const pool = fakePool((text) => (/returning id/.test(text) ? [{ id: '5' }] : []));
  await createRepo(pool).publish({ manifest, tarball: Buffer.from('x'), chunks: [{ text: 'a', embedding: [1] }] });
  assert.match(pool.calls[0].text, /on conflict \(owner_id, kind, url\)/);
  for (const c of pool.calls.filter((x) => /^insert/.test(x.text.trim()))) {
    assert.doesNotMatch(c.text.split('values')[0], /owner_id/, `owner_id comes from the column default: ${c.text}`);
  }
});

test('getTarball reads the bytes from blobs through the current version', async () => {
  const pool = fakePool(() => [{ kind: 'skill', plugin_slug: null, sha256: 'f'.repeat(64), tarball: Buffer.from('TGZ') }]);
  const row = await createRepo(pool).getTarball('s');
  assert.equal(Buffer.from(row.tarball).toString(), 'TGZ');
  assert.match(pool.calls[0].text, /left join blobs b on b\.sha256 = v\.blob_sha256/);
  assert.match(pool.calls[0].text, /b\.data as tarball/);
});

test('repoForOwner runs every repo method in its own withOwner call for that owner', async () => {
  const seen = [];
  const withOwner = async (ownerId, fn) => { seen.push(ownerId); return fn(fakePool(() => [{ id: '3' }])); };
  const repo = repoForOwner(withOwner, 42);
  assert.deepEqual(Object.keys(repo).sort(), [...REPO_METHODS].sort());
  assert.deepEqual(await repo.searchText('remotion', 5), [3]);
  assert.equal(await repo.versionExists('s', '1'.repeat(64)), true);
  assert.deepEqual(seen, [42, 42]);
});
