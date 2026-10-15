import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { createHandlers, ENRICH_TIMEOUT_MS, PURPOSES } from '../../lib/handlers.mjs';
import { createIdentity } from '../../lib/identity.mjs';
import { qualityPrior, QUALITY_PRIOR_WEIGHT } from '../../lib/rank.mjs';
import { ConflictError } from '../../lib/errors.mjs';
import { pack } from '../../lib/tar.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { file } from '../helpers.mjs';
import { bearerResolver } from '../server-helpers.mjs';

const TOKEN = 't0k3n';
const auth = { authorization: `Bearer ${TOKEN}` };
const req = (path, init = {}) => new Request(`https://sv.test${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

function fakeRepo(overrides = {}) {
  const calls = { publish: [], markUpstream: [], versionExists: [], repoFor: [] };
  const skills = [
    { id: 1, slug: 'remotion-render', name: 'remotion-render', description: 'Render', kind: 'skill', plugin_slug: null, update_available: false },
    { id: 2, slug: 'noncore-plugin@example', name: 'vercel', description: 'Vercel plugin', kind: 'plugin', plugin_slug: null, update_available: false },
    { id: 3, slug: 'humanizer', name: 'humanizer', description: 'Humanize', kind: 'skill', plugin_slug: null, update_available: true },
  ];
  return {
    calls,
    searchVector: async () => [{ id: 1, sim: 0.9 }, { id: 2, sim: 0.8 }],
    searchText: async () => [3, 1],
    getSkillsByIds: async (ids) => skills.filter((s) => ids.includes(s.id)),
    getSkill: async (slug) => (slug === 'remotion-render' ? { slug, sha256: 'f'.repeat(64), kind: 'skill' } : null),
    getTarball: async (slug) => ({
      'remotion-render': { kind: 'skill', plugin_slug: null, sha256: 'f'.repeat(64), tarball: Buffer.from('TGZ') },
      'noncore-plugin@example': { kind: 'plugin', plugin_slug: null, sha256: 'e'.repeat(64), tarball: null },
      'noncore-plugin@example:nextjs': { kind: 'skill', plugin_slug: 'noncore-plugin@example', sha256: 'd'.repeat(64), tarball: null },
    })[slug] ?? null,
    listVersions: async () => [{ id: 1, sha256: 'f'.repeat(64), status: 'approved', current: true }],
    listReviews: async () => [
      { commit_sha: 'a'.repeat(40), status: 'approved', reviewed_at: '2026-01-01T00:00:00.000Z', review_notes: 'ok', sha256: 'f'.repeat(64), current: true },
    ],
    versionExists: async (...args) => { calls.versionExists.push(args); return false; },
    publish: async (arg) => { calls.publish.push(arg); return { skillId: 9, versionId: 10 }; },
    listUpdates: async ({ grandfathered }) => (grandfathered ? [{ slug: 'humanizer' }] : [{ slug: 'remotion-render' }]),
    listUpstreamTargets: async () => [
      { skill_id: 1, kind: 'github', url: 'https://github.com/o/r', default_ref: 'HEAD', commit_sha: 'a'.repeat(40), source_path: 'skills/remotion-render' },
      { skill_id: 2, kind: 'github', url: 'https://github.com/o/r', default_ref: 'HEAD', commit_sha: 'a'.repeat(40), source_path: 'skills/vercel' },
      { skill_id: 3, kind: 'git', url: 'https://broken.example/r.git', default_ref: 'HEAD', commit_sha: null, source_path: null },
    ],
    markUpstream: async (...args) => { calls.markUpstream.push(args); },
    deleteEventsOlderThan: async () => 0,
    ...overrides,
  };
}

const fakeEmbed = async (texts) => texts.map(() => Array(1536).fill(0.1));

const OWNER = 7;
// identify / repoFor / listOwnerIds over one fake repo: the bearer `token` resolves to OWNER (an empty token matches
// nobody); repoFor calls are recorded.
function ownerDeps(repo, token = TOKEN) {
  const identity = createIdentity({ resolvers: [bearerResolver(token)], resolveOwner: async () => OWNER });
  return {
    identify: identity.identify,
    repoFor: (ownerId) => { repo.calls.repoFor.push(ownerId); return repo; },
    listOwnerIds: async () => [OWNER],
  };
}

// GitHub API for o/r: both skills' paths last changed at b…; at the reviewed commit a… remotion-render's tree differs
// from HEAD and vercel's does not. Any other URL answers 500. Records every fetched URL and its headers.
const GH = 'https://api.github.com/repos/o/r';
const dirs = (render, vercel) => [{ name: 'remotion-render', type: 'dir', sha: render }, { name: 'vercel', type: 'dir', sha: vercel }];
const GH_ROUTES = {
  [`${GH}/commits?sha=HEAD&path=skills/remotion-render&per_page=1`]: [{ sha: 'b'.repeat(40) }],
  [`${GH}/commits?sha=HEAD&path=skills/vercel&per_page=1`]: [{ sha: 'b'.repeat(40) }],
  [`${GH}/contents/skills?ref=${'a'.repeat(40)}`]: dirs('1'.repeat(40), '3'.repeat(40)),
  [`${GH}/contents/skills?ref=HEAD`]: dirs('2'.repeat(40), '3'.repeat(40)),
};

function make(overrides, env = {}, token = TOKEN) {
  const repo = fakeRepo(overrides);
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push([url, init.headers]);
    return url in GH_ROUTES ? Response.json(GH_ROUTES[url]) : new Response('x', { status: 500 });
  };
  const fullEnv = { CRON_SECRET: 'cron', ...env };
  return { repo, fetched, h: createHandlers({ ...ownerDeps(repo, token), embed: fakeEmbed, env: fullEnv, fetchImpl }) };
}

test('rejects missing or wrong token', async () => {
  const { h } = make();
  assert.equal((await h.search(new Request('https://sv.test/api/search?q=x'))).status, 401);
  assert.equal((await h.search(new Request('https://sv.test/api/search?q=x', { headers: { authorization: 'Bearer nope' } }))).status, 401);
});

test('rejects everything when no credential is configured', async () => {
  const { h } = make({}, {}, '');
  assert.equal((await h.search(req('/api/search?q=x'))).status, 401);
});

test('search fuses rankings and filters by kind', async () => {
  const { h } = make();
  const body = await (await h.search(req('/api/search?q=render%20video'))).json();
  assert.deepEqual(body.results.map((r) => r.slug), ['remotion-render', 'humanizer', 'noncore-plugin@example']);
  assert.ok(body.results[0].score > body.results[1].score);
  assert.equal(body.results[1].update_available, true);
  const plugins = await (await h.search(req('/api/search?q=x&kind=plugin'))).json();
  assert.deepEqual(plugins.results.map((r) => r.slug), ['noncore-plugin@example']);
  const one = await (await h.search(req('/api/search?q=x&k=1'))).json();
  assert.equal(one.results.length, 1);
});

test('search validates q, k and kind', async () => {
  const { h } = make();
  for (const qs of ['', '?q=%20%20', '?q=x&k=0', '?q=x&k=26', '?q=x&k=2.5', '?q=x&kind=mcp']) {
    const res = await h.search(req(`/api/search${qs}`));
    assert.equal(res.status, 400, qs);
    assert.equal((await res.json()).error.code, 'bad_request');
  }
});

test('getSkill returns 200 or 404', async () => {
  const { h } = make();
  assert.equal((await (await h.getSkill(req('/api/skills/remotion-render'))).json()).skill.slug, 'remotion-render');
  assert.equal((await h.getSkill(req('/api/skills/missing'))).status, 404);
  assert.equal((await h.getSkill(req('/api/skills/bad%20slug'))).status, 400);
});

test('download returns bytes with hash header, 409 for plugins, 404 when missing', async () => {
  const { h } = make();
  const ok = await h.download(req('/api/skills/remotion-render/download'));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-skill-sha256'), 'f'.repeat(64));
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'TGZ');
  assert.equal((await h.download(req('/api/skills/noncore-plugin@example/download'))).status, 409);
  assert.equal((await h.download(req(`/api/skills/${encodeURIComponent('noncore-plugin@example:nextjs')}/download`))).status, 409);
  assert.equal((await h.download(req('/api/skills/missing/download'))).status, 404);
});

test('versions returns 404 for unknown skill', async () => {
  const { h } = make();
  assert.equal((await (await h.versions(req('/api/skills/remotion-render/versions'))).json()).versions.length, 1);
  assert.equal((await h.versions(req('/api/skills/missing/versions'))).status, 404);
});

test('reviews returns the review history, or 404 for unknown skill', async () => {
  const { h } = make();
  const body = await (await h.reviews(req('/api/skills/remotion-render/reviews'))).json();
  assert.deepEqual(body.reviews, [
    { commit_sha: 'a'.repeat(40), status: 'approved', reviewed_at: '2026-01-01T00:00:00.000Z', review_notes: 'ok', sha256: 'f'.repeat(64), current: true },
  ]);
  assert.equal((await h.reviews(req('/api/skills/missing/reviews'))).status, 404);
  assert.equal((await h.reviews(req('/api/skills/bad%20slug/reviews'))).status, 400);
});

function publishReq(manifest, tarball) {
  const form = new FormData();
  form.set('manifest', typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (tarball) form.set('tarball', new Blob([tarball]), 'skill.tgz');
  return req('/api/skills', { method: 'POST', body: form });
}

const files = [file('SKILL.md', '---\nname: demo\ndescription: Demo skill\n---\n# Use\nDo it.')];
const manifest = {
  slug: 'demo', name: 'demo', description: 'Demo skill', kind: 'skill', tags: [], source: { kind: 'local' },
  sha256: hashFiles(files), status: 'approved', review_notes: 'ok', scan_flags: [], chunks: ['demo: Demo skill', 'demo — Use: Do it.'],
};

test('publish verifies folder hash and embeds chunks', async () => {
  const { h, repo } = make();
  const res = await h.publish(publishReq(manifest, pack(files)));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { skillId: 9, versionId: 10 });
  const call = repo.calls.publish[0];
  assert.equal(call.chunks.length, 2);
  assert.equal(call.chunks[1].text, 'demo — Use: Do it.');
  assert.equal(call.chunks[1].embedding.length, 1536);
  assert.ok(Buffer.isBuffer(call.tarball));
});

test('publish rejects hash mismatch, bad manifest and missing tarball', async () => {
  const { h, repo } = make();
  const mismatch = await h.publish(publishReq({ ...manifest, sha256: '0'.repeat(64) }, pack(files)));
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, 'hash_mismatch');
  assert.equal((await h.publish(publishReq('{not json'))).status, 400);
  assert.equal((await h.publish(publishReq({ ...manifest, slug: 'bad slug' }, pack(files)))).status, 400);
  assert.equal((await h.publish(publishReq({ ...manifest, status: 'maybe' }, pack(files)))).status, 400);
  assert.equal((await h.publish(publishReq(manifest))).status, 400);
  assert.equal((await h.publish(publishReq(manifest, Buffer.from('not a tarball')))).status, 400);
  assert.equal(repo.calls.publish.length, 0);
});

test('publish of rejected version and plugin skills needs no tarball and no embeddings', async () => {
  let embedded = 0;
  const repo = fakeRepo();
  const h = createHandlers({ ...ownerDeps(repo), embed: async (t) => { embedded += t.length; return fakeEmbed(t); }, env: {} });
  assert.equal((await h.publish(publishReq({ ...manifest, status: 'rejected', chunks: [] }))).status, 201);
  assert.equal(embedded, 0);
  const pluginSkill = { ...manifest, slug: 'noncore-plugin@example:nextjs', plugin_slug: 'noncore-plugin@example' };
  assert.equal((await h.publish(publishReq(pluginSkill))).status, 201);
  assert.equal(embedded, 2);
});

test('publish maps ConflictError to 409', async () => {
  const { h } = make({ publish: async () => { throw new ConflictError('dup'); } });
  assert.equal((await h.publish(publishReq(manifest, pack(files)))).status, 409);
});

test('updates lists and filters grandfathered', async () => {
  const { h } = make();
  assert.deepEqual((await (await h.updates(req('/api/updates'))).json()).updates, [{ slug: 'remotion-render' }]);
  assert.deepEqual((await (await h.updates(req('/api/updates?grandfathered=1'))).json()).updates, [{ slug: 'humanizer' }]);
});

test('cron requires CRON_SECRET, marks per-skill updates and reports per-source errors', async () => {
  const { h, repo, fetched } = make({}, { GITHUB_TOKEN: 'ghtok' });
  assert.equal((await h.cron(req('/api/cron/check-upstream'))).status, 401);
  const res = await h.cron(new Request('https://sv.test/api/cron/check-upstream', { headers: { authorization: 'Bearer cron' } }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.checked, 3);
  assert.equal(body.updates, 1);
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].skill_id, 3);
  assert.match(body.errors[0].error, /git 500/);
  assert.deepEqual(repo.calls.markUpstream, [[1, 'b'.repeat(40), true], [2, 'b'.repeat(40), false]]);
  const github = fetched.filter(([url]) => url.startsWith('https://api.github.com/'));
  assert.equal(github.filter(([url]) => url === `${GH}/contents/skills?ref=HEAD`).length, 1, 'one listing per run for the shared parent');
  assert.ok(github.every(([, headers]) => headers.authorization === 'Bearer ghtok'));
});

test('unexpected repo errors become 500 without leaking details', async () => {
  const { h } = make({ getSkill: async () => { throw new Error('connection string postgres://secret'); } });
  const res = await h.getSkill(req('/api/skills/remotion-render'));
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes('secret'));
});

test('publish of a rejected version drops the tarball (rejected versions store none)', async () => {
  const { h, repo } = make();
  const res = await h.publish(publishReq({ ...manifest, status: 'rejected', chunks: [] }, pack(files)));
  assert.equal(res.status, 201);
  assert.equal(repo.calls.publish.length, 1);
  assert.equal(repo.calls.publish[0].tarball, null);
  assert.deepEqual(repo.calls.publish[0].chunks, []);
});

test('cron reports unsafe upstream urls as per-target errors without fetching them', async () => {
  const fetched = [];
  const repo = fakeRepo({
    listUpstreamTargets: async () => [
      { skill_id: 4, kind: 'git', url: 'http://git.example.com/r.git', default_ref: 'HEAD', commit_sha: null },
      { skill_id: 5, kind: 'git', url: 'https://127.0.0.1/r.git', default_ref: 'HEAD', commit_sha: null },
    ],
  });
  const h = createHandlers({ ...ownerDeps(repo, ''), embed: fakeEmbed, env: { CRON_SECRET: 'cron' }, fetchImpl: async (url) => { fetched.push(url); return new Response('x'); } });
  const body = await (await h.cron(new Request('https://sv.test/api/cron/check-upstream', { headers: { authorization: 'Bearer cron' } }))).json();
  assert.equal(body.checked, 2);
  assert.deepEqual(body.errors.map((e) => e.skill_id), [4, 5]);
  assert.match(body.errors[0].error, /unsupported upstream url/);
  assert.match(body.errors[1].error, /upstream host not allowed/);
  assert.deepEqual(fetched, []);
  assert.deepEqual(repo.calls.markUpstream, []);
});

// --- Search enrichment on publish ---

function enrichHarness({ enrich, enrichTimeoutMs, repo: overrides, embed = fakeEmbed } = {}) {
  const repo = fakeRepo(overrides);
  const embedded = [];
  const logged = [];
  const h = createHandlers({
    ...ownerDeps(repo),
    embed: async (t) => { embedded.push(t); return embed(t); },
    enrich,
    enrichTimeoutMs,
    log: (...a) => logged.push(a.join(' ')),
    env: {},
  });
  return { h, repo, embedded, logged };
}

test('publish enriches approved versions: content + query chunks, merged tags', async () => {
  const seen = [];
  const { h, repo, embedded } = enrichHarness({
    enrich: async (s) => { seen.push(s); return { queries_en: ['how do I demo'], queries_es: ['hacer una demo'], tags: ['Audio', 'demo-tag'] }; },
  });
  const res = await h.publish(publishReq({ ...manifest, tags: ['Demo', 'audio'] }, pack(files)));
  assert.equal(res.status, 201);
  assert.deepEqual(seen, [{ name: 'demo', description: 'Demo skill', body: '# Use\nDo it.' }]);
  const { chunks, manifest: stored } = repo.calls.publish[0];
  assert.deepEqual(chunks.map((c) => [c.kind, c.text]), [
    ['content', 'demo: Demo skill'], ['content', 'demo — Use: Do it.'], ['query', 'how do I demo'], ['query', 'hacer una demo'],
  ]);
  assert.ok(chunks.every((c) => c.embedding.length === 1536));
  assert.equal(embedded.length, 1, 'one embedding call for content and queries');
  assert.deepEqual(stored.tags, ['demo', 'audio', 'demo-tag']);
  assert.deepEqual(repo.calls.publish[0].queriesEs, ['hacer una demo']);
});

test('publish caps merged tags at 8', async () => {
  const { h, repo } = enrichHarness({ enrich: async () => ({ queries_en: ['q'], queries_es: [], tags: ['f', 'g', 'h', 'i', 'j', 'k'] }) });
  await h.publish(publishReq({ ...manifest, tags: ['a', 'b', 'c', 'd', 'e'] }, pack(files)));
  assert.deepEqual(repo.calls.publish[0].manifest.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});

test('publish logs and continues without enrichment when it throws', async () => {
  const { h, repo, logged } = enrichHarness({ enrich: async () => { throw new Error('gateway down'); } });
  const res = await h.publish(publishReq({ ...manifest, tags: ['X'] }, pack(files)));
  assert.equal(res.status, 201);
  const { chunks, manifest: stored } = repo.calls.publish[0];
  assert.deepEqual(chunks.map((c) => c.kind), ['content', 'content']);
  assert.deepEqual(stored.tags, ['x']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /enrichment failed for demo.*gateway down/);
});

test('publish gives up on enrichment after the timeout and still publishes', async () => {
  const { h, repo, logged } = enrichHarness({ enrich: () => new Promise(() => {}), enrichTimeoutMs: 20 });
  const res = await h.publish(publishReq(manifest, pack(files)));
  assert.equal(res.status, 201);
  assert.deepEqual(repo.calls.publish[0].chunks.map((c) => c.kind), ['content', 'content']);
  assert.equal(repo.calls.publish[0].queriesEs, null, 'no enrichment: the repo clears the Spanish text with the query chunks');
  assert.match(logged[0], /timed out after 20 ms/);
});

test('the enrichment timeout defaults to 20 s', () => {
  assert.equal(ENRICH_TIMEOUT_MS, 20_000);
});

test('publish treats malformed enrichment output as a failure', async () => {
  const { h, repo, logged } = enrichHarness({ enrich: async () => ({ queries: 'nope' }) });
  assert.equal((await h.publish(publishReq(manifest, pack(files)))).status, 201);
  assert.deepEqual(repo.calls.publish[0].chunks.map((c) => c.kind), ['content', 'content']);
  assert.equal(logged.length, 1);
});

test('publish rejects enrichment output without queries_es, even when queries and queries_en are there', async () => {
  const { h, repo, logged } = enrichHarness({ enrich: async () => ({ queries_en: ['how do I demo'], queries: ['how do I demo'], tags: ['audio'] }) });
  assert.equal((await h.publish(publishReq(manifest, pack(files)))).status, 201);
  const [call] = repo.calls.publish;
  assert.deepEqual(call.chunks.map((c) => c.kind), ['content', 'content']);
  assert.deepEqual(call.manifest.tags, []);
  assert.equal(call.queriesEs, null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /enrichment failed for demo.*invalid result/);
});

test('rejected versions are not enriched; plugin skills are enriched with their manifest chunks as the body', async () => {
  const seen = [];
  const { h, repo } = enrichHarness({ enrich: async (s) => { seen.push(s); return { queries_en: ['q'], queries_es: ['c'], tags: [] }; } });
  assert.equal((await h.publish(publishReq({ ...manifest, status: 'rejected', chunks: [] }))).status, 201);
  assert.equal(seen.length, 0);
  assert.equal(repo.calls.publish[0].queriesEs, null);
  const pluginSkill = { ...manifest, slug: 'noncore-plugin@example:nextjs', plugin_slug: 'noncore-plugin@example' };
  assert.equal((await h.publish(publishReq(pluginSkill))).status, 201);
  assert.deepEqual(seen, [{ name: 'demo', description: 'Demo skill', body: 'demo: Demo skill\n\ndemo — Use: Do it.' }]);
});

// --- Ranking: quality prior and marketplace dedupe ---

// searchVector rows for a list of ids, best first.
const byVector = (ids) => ids.map((id, i) => ({ id, sim: 0.9 - i / 100 }));
const row = (id, slug, extra = {}) => ({ id, slug, name: slug, description: slug, kind: 'skill', plugin_slug: null, update_available: false, tags: [], quality: null, ...extra });

test('search breaks an RRF tie with a small quality prior: 0.0001 * sum(scores) / 12', async () => {
  const rows = [row(1, 'audio-production'), row(2, 'auphonic-mastering', { quality: { reuse: 1, trigger: 3, content: 3, health: 2, verdict: 'VAULT_AFTER_FIX' } })];
  const { h } = make({ searchVector: async () => byVector([1, 2]), searchText: async () => [2, 1], getSkillsByIds: async () => rows });
  const { results } = await (await h.search(req('/api/search?q=master%20podcast%20audio%20loudness'))).json();
  assert.deepEqual(results.map((r) => r.slug), ['auphonic-mastering', 'audio-production']);
  const tie = 1 / 61 + 1 / 62;
  assert.ok(Math.abs(results[0].score - (tie + 0.0001 * 9 / 12)) < 1e-12);
  assert.equal(results[1].score, tie);
  assert.equal(QUALITY_PRIOR_WEIGHT, 0.0001);
});

test('without quality the tie still breaks by id, and the prior never beats a whole rank step', async () => {
  const perfect = { reuse: 3, trigger: 3, content: 3, health: 3 };
  const { h } = make({ searchVector: async () => byVector([1, 2]), searchText: async () => [1, 2], getSkillsByIds: async () => [row(1, 'a'), row(2, 'b', { quality: perfect })] });
  const { results } = await (await h.search(req('/api/search?q=x'))).json();
  assert.deepEqual(results.map((r) => r.slug), ['a', 'b'], 'rank 1 in both lists beats rank 2 + max prior');
  assert.equal(qualityPrior(null), 0);
  assert.equal(qualityPrior({ reuse: 3, trigger: 3, content: 3, health: 3 }), 0.0001);
  assert.equal(qualityPrior({ reuse: 'x', trigger: 3 }), 0.0001 * 3 / 12);
});

test('search results carry tags but not the raw quality object', async () => {
  const { h } = make({ searchVector: async () => byVector([1]), searchText: async () => [], getSkillsByIds: async () => [row(1, 'a', { tags: ['audio'], quality: { reuse: 1, trigger: 1, content: 1, health: 1 } })] });
  const { results } = await (await h.search(req('/api/search?q=x'))).json();
  assert.deepEqual(results[0].tags, ['audio']);
  assert.ok(!('quality' in results[0]));
  assert.ok(!('id' in results[0]));
});

test('search collapses the same plugin skill installed from two marketplaces, keeping the best-ranked', async () => {
  const rows = [
    row(4, 'claude-mem@acme-market:do', { name: 'do', plugin_slug: 'claude-mem@acme-market' }),
    row(5, 'claude-mem@acme-shared:do', { name: 'do', plugin_slug: 'claude-mem@acme-shared' }),
    row(6, 'other@m:do', { name: 'do', plugin_slug: 'other@m' }),
    row(7, 'do', { name: 'do' }),
    row(8, 'claude-mem@acme-shared:make-plan', { name: 'make-plan', plugin_slug: 'claude-mem@acme-shared' }),
  ];
  const { h } = make({ searchVector: async () => byVector([5, 4, 6, 7, 8]), searchText: async () => [], getSkillsByIds: async () => rows });
  const { results } = await (await h.search(req('/api/search?q=do'))).json();
  assert.deepEqual(results.map((r) => r.slug), ['claude-mem@acme-shared:do', 'other@m:do', 'do', 'claude-mem@acme-shared:make-plan']);
  assert.deepEqual(results[0].alternatives, ['claude-mem@acme-market:do']);
  assert.ok(!('alternatives' in results[1]));
  const two = await (await h.search(req('/api/search?q=do&k=2'))).json();
  assert.deepEqual(two.results.map((r) => r.slug), ['claude-mem@acme-shared:do', 'other@m:do'], 'collapsed duplicates do not use up k');
});

// --- Per-result signals and the full-text variant ---

test('search results carry fts_rank, vector_rank, similarity, matched and variant (rrf-english by default)', async () => {
  const opts = [];
  const { h } = make({
    searchVector: async () => [{ id: 1, sim: 0.83 }, { id: 2, sim: 0.61 }],
    searchText: async (q, n, tags, o) => { opts.push(o); return [3, 1]; },
  });
  const { results } = await (await h.search(req('/api/search?q=render%20video'))).json();
  const bySlug = Object.fromEntries(results.map((r) => [r.slug, r]));
  assert.deepEqual(opts, [{ bilingual: false }]);
  const signals = ({ fts_rank, vector_rank, similarity, matched, variant }) => ({ fts_rank, vector_rank, similarity, matched, variant });
  assert.deepEqual(signals(bySlug['remotion-render']), { fts_rank: 2, vector_rank: 1, similarity: 0.83, matched: 'both', variant: 'rrf-english' });
  assert.deepEqual(signals(bySlug['noncore-plugin@example']), { fts_rank: null, vector_rank: 2, similarity: 0.61, matched: 'vector', variant: 'rrf-english' });
  assert.deepEqual(signals(bySlug.humanizer), { fts_rank: 1, vector_rank: null, similarity: null, matched: 'fts', variant: 'rrf-english' });
  assert.equal(bySlug.humanizer.update_available, true, 'existing fields stay');
  assert.equal(typeof bySlug.humanizer.score, 'number');
});

// Handlers whose resolveFlags is `resolveFlags`; records each call's arguments, searchText's options and log lines.
function flagsHarness(resolveFlags) {
  const repo = fakeRepo();
  const opts = [];
  const flagCalls = [];
  const logged = [];
  repo.searchText = async (q, n, tags, o) => { opts.push(o); return [3, 1]; };
  const env = {};
  const h = createHandlers({
    ...ownerDeps(repo), embed: fakeEmbed, env, log: (...a) => logged.push(a.join(' ')),
    resolveFlags: async (...args) => { flagCalls.push(args); return resolveFlags(...args); },
  });
  return { h, opts, flagCalls, logged };
}

test('only bilingualFts true and ranking rrf-bilingual take the bilingual path; the other three are control', async () => {
  const matrix = [
    [{ bilingualFts: false, ranking: 'rrf-english' }, 'rrf-english'],
    [{ bilingualFts: false, ranking: 'rrf-bilingual' }, 'rrf-english'],
    [{ bilingualFts: true, ranking: 'rrf-english' }, 'rrf-english'],
    [{ bilingualFts: true, ranking: 'rrf-bilingual' }, 'rrf-bilingual'],
  ];
  for (const [flags, variant] of matrix) {
    const { h, opts, flagCalls } = flagsHarness(async () => flags);
    const request = req('/api/search?q=x');
    const res = await h.search(request);
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.equal(flagCalls.length, 1);
    assert.equal(flagCalls[0][0], request);
    assert.deepEqual(opts, [{ bilingual: variant === 'rrf-bilingual' }], JSON.stringify(flags));
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.variant === variant), JSON.stringify(flags));
  }
});

test('a throwing or odd resolveFlags falls back to control and the search still answers 200', async () => {
  const cases = {
    throws: async () => { throw new Error('flags down'); },
    'unknown ranking': async () => ({ bilingualFts: true, ranking: 'rrf-spanish' }),
    'truthy non-boolean kill switch': async () => ({ bilingualFts: 'true', ranking: 'rrf-bilingual' }),
    'no value': async () => undefined,
  };
  for (const [name, resolveFlags] of Object.entries(cases)) {
    const { h, opts, logged } = flagsHarness(resolveFlags);
    const res = await h.search(req('/api/search?q=x'));
    assert.equal(res.status, 200, name);
    const { results } = await res.json();
    assert.deepEqual(opts, [{ bilingual: false }], name);
    assert.ok(results.length > 0 && results.every((r) => r.variant === 'rrf-english'), name);
    assert.deepEqual(logged, name === 'throws' ? ['search flags unavailable, using control: flags down'] : [], name);
  }
});

// --- Tag filter ---

test('search passes tags (repeatable or comma-separated, lowercased, deduped) to both candidate lists', async () => {
  const seen = [];
  const { h } = make({
    searchVector: async (v, n, tags) => { seen.push(['vector', n, tags]); return byVector([1]); },
    searchText: async (q, n, tags) => { seen.push(['text', n, tags]); return [1]; },
  });
  const res = await h.search(req('/api/search?q=x&tag=Python&tag=godot,python&tag='));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [['vector', 50, ['python', 'godot']], ['text', 50, ['python', 'godot']]]);
  seen.length = 0;
  await h.search(req('/api/search?q=x'));
  assert.deepEqual(seen.map((s) => s[2]), [[], []]);
});

test('search normalizes ?tag= like stored tags and rejects only values that normalize to empty, or more than 8', async () => {
  const seen = [];
  const { h } = make({ searchVector: async (v, n, tags) => { seen.push(tags); return byVector([1]); } });
  const cases = [['tag=three.js', ['threejs']], ['tag=bad%20tag', ['bad-tag']], ['tag=a_b', ['a-b']], ['tag=-a', ['a']],
    [`tag=${'x'.repeat(51)}`, ['x'.repeat(50)]], ['tag=Three.JS,threejs', ['threejs']]];
  for (const [qs, want] of cases) {
    seen.length = 0;
    const res = await h.search(req(`/api/search?q=x&${qs}`));
    assert.equal(res.status, 200, qs);
    assert.deepEqual(seen, [want], qs);
  }
  const nine = Array.from({ length: 9 }, (_, i) => `t${i}`).join(',');
  for (const qs of ['tag=!!!', 'tag=ok,...', 'tag=---', `tag=${nine}`]) {
    const res = await h.search(req(`/api/search?q=x&${qs}`));
    assert.equal(res.status, 400, qs);
    assert.equal((await res.json()).error.code, 'bad_request');
  }
});

test('getSkill returns tags and quality from the repo row', async () => {
  const { h } = make({ getSkill: async (slug) => ({ slug, tags: ['audio'], quality: { reuse: 3, verdict: 'VAULT' } }) });
  const { skill } = await (await h.getSkill(req('/api/skills/text-to-speech'))).json();
  assert.deepEqual(skill.tags, ['audio']);
  assert.deepEqual(skill.quality, { reuse: 3, verdict: 'VAULT' });
});

// --- Fix round 1: hostile enrichers, duplicate pre-check ---

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Like Postgres: a NUL in a text column fails the insert ("invalid byte sequence for encoding UTF8: 0x00").
const pgLikePublish = (calls) => async (arg) => {
  if (arg.chunks.some((c) => c.text.includes('\u0000')) || arg.manifest.tags.some((t) => t.includes('\u0000'))) {
    throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
  }
  calls.push(arg);
  return { skillId: 9, versionId: 10 };
};

test('publish returns 201 with a hostile enricher (NUL, huge strings, 1000 queries) and stores only clean, bounded query chunks', async () => {
  const stored = [];
  const hostile = {
    queries_en: ['e\u0000f', 'x'.repeat(1_000_000), `a${'\u0001'.repeat(5000)}b`, ...Array.from({ length: 1000 }, (_, i) => `q${i}\u0000 \uD800`)],
    queries_es: ['u\u0000no', 'y'.repeat(1_000_000), ...Array.from({ length: 1000 }, (_, i) => `s${i}\u0001 \uDC00`)],
    tags: ['t\u0000ag', 'Y'.repeat(100_000), ...Array.from({ length: 1000 }, (_, i) => `tag ${i}`)],
  };
  const { h, embedded } = enrichHarness({ enrich: async () => hostile, repo: { publish: pgLikePublish(stored) } });
  const res = await h.publish(publishReq(manifest, pack(files)));
  assert.equal(res.status, 201);
  const [{ chunks, manifest: m, queriesEs }] = stored;
  const queries = chunks.filter((c) => c.kind === 'query').map((c) => c.text);
  assert.ok(queries.length > 0 && queries.length <= 8, `${queries.length} query chunks`);
  assert.equal(queries[0], 'ef');
  assert.ok(queriesEs.length > 0 && queriesEs.length <= 3, `${queriesEs.length} Spanish queries`);
  assert.equal(queriesEs[0], 'uno');
  for (const q of [...queries, ...queriesEs]) {
    assert.ok(q.length <= 140);
    assert.ok(!CONTROL.test(q) && !LONE_SURROGATE.test(q), JSON.stringify(q));
  }
  assert.deepEqual(chunks.filter((c) => c.kind === 'content').map((c) => c.text), manifest.chunks);
  assert.ok(m.tags.length <= 6, 'enrichment adds at most 6 tags');
  assert.ok(m.tags.every((t) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t) && t.length <= 50));
  assert.ok(embedded.flat().length <= manifest.chunks.length + 8, 'the embedder never sees more than 8 queries');
});

test('publish retries the embedding with content chunks only when embedding the queries fails, and logs it', async () => {
  const { h, repo, logged, embedded } = enrichHarness({
    enrich: async () => ({ queries_en: ['how do I demo'], queries_es: [], tags: ['audio'] }),
    embed: async (t) => { if (t.length > manifest.chunks.length) throw new Error('input rejected'); return fakeEmbed(t); },
  });
  const res = await h.publish(publishReq(manifest, pack(files)));
  assert.equal(res.status, 201);
  assert.equal(embedded.length, 2);
  const { chunks, manifest: m } = repo.calls.publish[0];
  assert.deepEqual(chunks.map((c) => c.kind), ['content', 'content']);
  assert.deepEqual(m.tags, ['audio']);
  assert.match(logged.join('\n'), /embedding.*queries failed for demo.*input rejected/);
});

test('publish still fails when the content chunks alone cannot be embedded', async () => {
  const { h, repo } = enrichHarness({
    enrich: async () => ({ queries_en: ['q'], queries_es: [], tags: [] }),
    embed: async () => { throw new Error('gateway down'); },
  });
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal((await h.publish(publishReq(manifest, pack(files)))).status, 500);
  } finally {
    console.error = origErr;
  }
  assert.equal(repo.calls.publish.length, 0);
});

test('publish of an already published (slug, sha256) returns 409 before any enrichment or embedding', async () => {
  let enriched = 0;
  const { h, repo, embedded } = enrichHarness({
    enrich: async () => { enriched++; return { queries_en: ['q'], queries_es: [], tags: [] }; },
    repo: { versionExists: async (...args) => { repo.calls.versionExists.push(args); return true; } },
  });
  const res = await h.publish(publishReq(manifest, pack(files)));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'conflict');
  assert.deepEqual(repo.calls.versionExists, [['demo', manifest.sha256]]);
  assert.equal(enriched, 0);
  assert.equal(embedded.length, 0);
  assert.equal(repo.calls.publish.length, 0);
});

test('a new (slug, sha256) is checked once and then published', async () => {
  const { h, repo } = enrichHarness({ enrich: async () => ({ queries_en: ['q'], queries_es: [], tags: [] }) });
  assert.equal((await h.publish(publishReq(manifest, pack(files)))).status, 201);
  assert.deepEqual(repo.calls.versionExists, [['demo', manifest.sha256]]);
  assert.equal(repo.calls.publish.length, 1);
});

// --- Multi-user foundation ---

test('every user route runs against the repo of the identified owner, and a 401 never touches a repo', async () => {
  const { h, repo } = make();
  await h.search(req('/api/search?q=x'));
  await h.getSkill(req('/api/skills/remotion-render'));
  await h.download(req('/api/skills/remotion-render/download'));
  await h.versions(req('/api/skills/remotion-render/versions'));
  await h.reviews(req('/api/skills/remotion-render/reviews'));
  await h.updates(req('/api/updates'));
  assert.deepEqual(repo.calls.repoFor, [OWNER, OWNER, OWNER, OWNER, OWNER, OWNER]);
  await h.search(new Request('https://sv.test/api/search?q=x', { headers: { authorization: 'Bearer nope' } }));
  assert.equal(repo.calls.repoFor.length, 6);
});

test('an identity failure is a 500 without details, not a 401 or an anonymous request', async () => {
  const repo = fakeRepo();
  const h = createHandlers({ identify: async () => { throw new Error('db down: secret host'); }, repoFor: () => repo, listOwnerIds: async () => [], embed: fakeEmbed, env: {} });
  const res = await h.search(req('/api/search?q=x'));
  assert.equal(res.status, 500);
  assert.doesNotMatch(await res.text(), /secret host/);
});

test('cron visits every owner through that owner’s repo and sums the results', async () => {
  const targetsByOwner = {
    1: [{ skill_id: 10, kind: 'github', url: 'https://github.com/o/r', default_ref: 'HEAD', commit_sha: 'a'.repeat(40) }],
    2: [{ skill_id: 20, kind: 'github', url: 'https://github.com/o/s', default_ref: 'HEAD', commit_sha: 'b'.repeat(40) }],
  };
  const marked = [];
  const repoFor = (ownerId) => ({
    listUpstreamTargets: async () => targetsByOwner[ownerId],
    markUpstream: async (...args) => { marked.push([ownerId, ...args]); },
    deleteEventsOlderThan: async () => 0,
  });
  const h = createHandlers({
    identify: async () => null, repoFor, listOwnerIds: async () => [1, 2], embed: fakeEmbed, env: { CRON_SECRET: 'cron' },
    fetchImpl: async (url) => Response.json({ sha: 'b'.repeat(40), commit: { tree: { sha: url.endsWith('/commits/HEAD') ? '2'.repeat(40) : '1'.repeat(40) } } }),
  });
  const body = await (await h.cron(new Request('https://sv.test/api/cron/check-upstream', { headers: { authorization: 'Bearer cron' } }))).json();
  assert.deepEqual(body, { checked: 2, updates: 1, errors: [] });
  assert.deepEqual(marked, [[1, 10, 'b'.repeat(40), true], [2, 20, 'b'.repeat(40), false]]);
});

test('cron with no owners checks nothing and still answers 200', async () => {
  const h = createHandlers({ identify: async () => null, repoFor: () => { throw new Error('no repo expected'); }, listOwnerIds: async () => [], embed: fakeEmbed, env: { CRON_SECRET: 'cron' } });
  const res = await h.cron(new Request('https://sv.test/api/cron/check-upstream', { headers: { authorization: 'Bearer cron' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { checked: 0, updates: 0, errors: [] });
});

// --- Measurement: exposure events, install events, safe embedding errors, retention ---

const HMAC_KEY = 'test-hmac-key';
const hmacHex = (key, text) => createHmac('sha256', key).update(text).digest('hex');
const SUGGEST = { 'x-headjack-session': 'sess-1', 'x-headjack-purpose': 'suggest' };

// Handlers over a fake repo that records logSearchEvent / logInstallEvent; `log` is captured. `deps` go straight to
// createHandlers (hmacKey, eventCapMs, resolveFlags, embed); `env` is merged over one that carries the HMAC key.
function eventsHarness({ repo: overrides, env: extraEnv = {}, ...deps } = {}) {
  const logged = [];
  const searchEvents = [];
  const installEvents = [];
  const repo = fakeRepo({
    logSearchEvent: async (e) => { searchEvents.push(e); },
    logInstallEvent: async (e) => { installEvents.push(e); },
    ...overrides,
  });
  const env = { SEARCH_EVENTS_HMAC_KEY: HMAC_KEY, ...extraEnv };
  const h = createHandlers({ ...ownerDeps(repo), embed: fakeEmbed, env, log: (...a) => logged.push(a.join(' ')), ...deps });
  return { h, repo, logged, searchEvents, installEvents };
}

test('a suggest search with a valid session logs one exposure: HMAC-SHA256 hex of q, the result slugs, the variant', async () => {
  const { h, searchEvents, logged } = eventsHarness({ resolveFlags: async () => ({ bilingualFts: true, ranking: 'rrf-bilingual' }) });
  const res = await h.search(req('/api/search?q=render%20video&k=2', { headers: SUGGEST }));
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results.length, 2);
  assert.deepEqual(searchEvents, [{
    sessionId: 'sess-1', variant: 'rrf-bilingual', queryHmac: hmacHex(HMAC_KEY, 'render video'), topSlugs: results.map((r) => r.slug),
  }]);
  assert.match(searchEvents[0].queryHmac, /^[0-9a-f]{64}$/);
  assert.deepEqual(logged, []);
});

test('resolveFlags gets the resolved owner id and the same session id the handler logs with', async () => {
  const flagCalls = [];
  const { h, searchEvents } = eventsHarness({
    resolveFlags: async (...args) => { flagCalls.push(args); return { bilingualFts: true, ranking: 'rrf-bilingual' }; },
  });
  await h.search(req('/api/search?q=x', { headers: SUGGEST }));
  assert.deepEqual(flagCalls[0][1], { ownerId: OWNER, sessionId: 'sess-1' });
  assert.equal(searchEvents[0].sessionId, 'sess-1');
  // Without a valid session the handler generates one: resolveFlags still gets an id (a UUID), never null.
  await h.search(req('/api/search?q=x', { headers: { 'x-headjack-session': 'bad_id' } }));
  assert.equal(flagCalls[1][1].ownerId, OWNER);
  assert.match(flagCalls[1][1].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('the purposes are suggest, plan, manual, eval and warmup; only suggest is logged', async () => {
  assert.deepEqual([...PURPOSES], ['suggest', 'plan', 'manual', 'eval', 'warmup']);
});

test('handlers read x-headjack-* headers', async () => {
  const { h, searchEvents, installEvents } = eventsHarness();
  assert.equal((await h.search(req('/api/search?q=x', { headers: { 'x-headjack-session': 'sess-9', 'x-headjack-purpose': 'suggest' } }))).status, 200);
  assert.deepEqual(searchEvents.map((e) => e.sessionId), ['sess-9']);
  assert.equal((await h.installEvent(installReq({ slug: 'demo', kind: 'skill', source: 'manual' }, { 'x-headjack-session': 'sess-9' }))).status, 204);
  assert.deepEqual(installEvents.map((e) => e.sessionId), ['sess-9']);
});

test('a request without x-headjack-* headers succeeds with purpose and session absent', async () => {
  const flagCalls = [];
  const { h, searchEvents, installEvents, logged } = eventsHarness({
    resolveFlags: async (...args) => { flagCalls.push(args); return { bilingualFts: true, ranking: 'rrf-bilingual' }; },
  });
  const res = await h.search(req('/api/search?q=x'));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).results.length > 0);
  assert.deepEqual(searchEvents, [], 'no purpose means manual: nothing logged');
  assert.match(flagCalls[0][1].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal((await h.installEvent(installReq({ slug: 'demo', kind: 'skill', source: 'manual' }))).status, 204);
  assert.deepEqual(installEvents, [{ sessionId: null, slug: 'demo', kind: 'skill', source: 'manual' }]);
  assert.deepEqual(logged, []);
});

test('hmacKey defaults to env.SEARCH_EVENTS_HMAC_KEY and can be injected', async () => {
  const { h, searchEvents } = eventsHarness({ hmacKey: 'injected-key' });
  assert.equal((await h.search(req('/api/search?q=x', { headers: SUGGEST }))).status, 200);
  assert.equal(searchEvents[0].queryHmac, hmacHex('injected-key', 'x'));
});

test('no exposure for plan/manual/unknown/missing purpose, or a missing or invalid session', async () => {
  const cases = {
    'purpose plan': { ...SUGGEST, 'x-headjack-purpose': 'plan' },
    'purpose manual': { ...SUGGEST, 'x-headjack-purpose': 'manual' },
    'purpose eval': { ...SUGGEST, 'x-headjack-purpose': 'eval' },
    'purpose warmup': { ...SUGGEST, 'x-headjack-purpose': 'warmup' },
    'purpose unknown': { ...SUGGEST, 'x-headjack-purpose': 'autocomplete' },
    'purpose missing': { 'x-headjack-session': 'sess-1' },
    'session missing': { 'x-headjack-purpose': 'suggest' },
    'session empty': { ...SUGGEST, 'x-headjack-session': '' },
    'session too long': { ...SUGGEST, 'x-headjack-session': 'a'.repeat(65) },
    'session with underscore': { ...SUGGEST, 'x-headjack-session': 'bad_id' },
    'session with dot': { ...SUGGEST, 'x-headjack-session': 'a.b' },
  };
  for (const [name, headers] of Object.entries(cases)) {
    const { h, searchEvents, logged } = eventsHarness();
    const res = await h.search(req('/api/search?q=x', { headers }));
    assert.equal(res.status, 200, name);
    assert.ok((await res.json()).results.length > 0, name);
    assert.deepEqual(searchEvents, [], name);
    assert.deepEqual(logged, [], name);
  }
  const { h, searchEvents } = eventsHarness();
  await h.search(req('/api/search?q=x', { headers: { ...SUGGEST, 'x-headjack-session': 'A-z0-9-'.padEnd(64, 'x') } }));
  assert.equal(searchEvents.length, 1, 'a 64-char [A-Za-z0-9-] session is valid');
});

test('search logs no exposure when the injected overridden(req) is true', async () => {
  const seen = [];
  const { h, searchEvents, logged } = eventsHarness({ overridden: (r) => { seen.push(r.headers.get('cookie')); return true; } });
  const res = await h.search(req('/api/search?q=x', { headers: { ...SUGGEST, cookie: 'theme=dark; vercel-flag-overrides=abc123' } }));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).results.length > 0);
  assert.deepEqual(seen, ['theme=dark; vercel-flag-overrides=abc123'], 'overridden gets the request');
  assert.deepEqual(searchEvents, []);
  assert.deepEqual(logged, []);
});

test('search logs exposure when overridden is absent, whatever cookie the request carries', async () => {
  const { h, searchEvents } = eventsHarness();
  await h.search(req('/api/search?q=x', { headers: { ...SUGGEST, cookie: 'theme=dark; vercel-flag-overrides=abc123' } }));
  assert.equal(searchEvents.length, 1);
});

test('a missing SEARCH_EVENTS_HMAC_KEY skips exposure logging, still answers, and is logged once per instance', async () => {
  const { h, searchEvents, logged } = eventsHarness({ env: { SEARCH_EVENTS_HMAC_KEY: '' } });
  assert.equal((await h.search(req('/api/search?q=x'))).status, 200);
  assert.deepEqual(logged, [], 'nothing to log for a search that would not be logged anyway');
  for (let i = 0; i < 2; i++) {
    const res = await h.search(req('/api/search?q=x', { headers: SUGGEST }));
    assert.equal(res.status, 200);
    assert.ok((await res.json()).results.length > 0);
  }
  assert.deepEqual(searchEvents, []);
  assert.deepEqual(logged, ['SEARCH_EVENTS_HMAC_KEY missing: exposure logging disabled']);
  const other = eventsHarness({ env: { SEARCH_EVENTS_HMAC_KEY: undefined } });
  await other.h.search(req('/api/search?q=x', { headers: SUGGEST }));
  assert.deepEqual(other.logged, ['SEARCH_EVENTS_HMAC_KEY missing: exposure logging disabled'], 'each instance logs it once');
});

test('a rejecting logSearchEvent is logged by message only and the search still answers 200', async () => {
  const { h, logged } = eventsHarness({
    repo: { logSearchEvent: async () => { throw Object.assign(new Error('insert failed'), { query: 'secret prompt' }); } },
  });
  const res = await h.search(req('/api/search?q=secret%20prompt', { headers: SUGGEST }));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).results.length > 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /insert failed/);
  assert.ok(!logged[0].includes('secret prompt'));
});

test('a hanging logSearchEvent is abandoned after eventCapMs and the search still answers 200', async () => {
  const { h, logged } = eventsHarness({ eventCapMs: 50, repo: { logSearchEvent: () => new Promise(() => {}) } });
  const t0 = Date.now();
  const res = await h.search(req('/api/search?q=secret%20prompt', { headers: SUGGEST }));
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.ok((await res.json()).results.length > 0);
  assert.ok(elapsed >= 45 && elapsed < 1000, `${elapsed} ms`);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /timed out after 50 ms/);
  assert.ok(!logged[0].includes('secret prompt'));
});

test('the exposure insert cap defaults to 500 ms', async () => {
  const { h } = eventsHarness({ repo: { logSearchEvent: () => new Promise(() => {}) } });
  const t0 = Date.now();
  assert.equal((await h.search(req('/api/search?q=x', { headers: SUGGEST }))).status, 200);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 450 && elapsed < 2000, `${elapsed} ms`);
});

const installReq = (body, headers = {}) => req('/api/events/install', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
});

test('installEvent records a valid install for the identified owner and answers 204', async () => {
  const { h, repo, installEvents } = eventsHarness();
  const res = await h.installEvent(installReq({ slug: 'p@m:skill', kind: 'skill', source: 'suggest' }, { 'x-headjack-session': 'sess-1' }));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.deepEqual(installEvents, [{ sessionId: 'sess-1', slug: 'p@m:skill', kind: 'skill', source: 'suggest' }]);
  assert.deepEqual(repo.calls.repoFor, [OWNER]);
  assert.equal((await h.installEvent(installReq({ slug: 'noncore-plugin@example', kind: 'plugin', source: 'plan' }))).status, 204);
  assert.equal((await h.installEvent(installReq({ slug: 'demo', kind: 'skill', source: 'manual' }, { 'x-headjack-session': 'bad_id' }))).status, 204);
  assert.deepEqual(installEvents.slice(1), [
    { sessionId: null, slug: 'noncore-plugin@example', kind: 'plugin', source: 'plan' },
    { sessionId: null, slug: 'demo', kind: 'skill', source: 'manual' },
  ], 'the session is optional: missing or invalid is null');
});

test('installEvent rejects invalid JSON, slug, kind or source with 400 and records nothing', async () => {
  const { h, installEvents } = eventsHarness();
  const good = { slug: 'demo', kind: 'skill', source: 'suggest' };
  const bodies = ['{not json', 'null', '"demo"', { ...good, slug: 'bad slug' }, { ...good, slug: 42 }, { ...good, slug: '' },
    { ...good, kind: 'mcp' }, { ...good, source: 'auto' }, { slug: 'demo' }, {}];
  for (const body of bodies) {
    const res = await h.installEvent(installReq(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, 'bad_request');
  }
  assert.deepEqual(installEvents, []);
});

test('installEvent without a valid token is 401 and touches no repo', async () => {
  const { h, repo, installEvents } = eventsHarness();
  const res = await h.installEvent(new Request('https://sv.test/api/events/install', { method: 'POST', body: JSON.stringify({ slug: 'demo', kind: 'skill', source: 'suggest' }) }));
  assert.equal(res.status, 401);
  assert.deepEqual(installEvents, []);
  assert.deepEqual(repo.calls.repoFor, []);
});

test('installEvent still answers 204 when the insert fails, logging the message only', async () => {
  const { h, logged } = eventsHarness({ repo: { logInstallEvent: async () => { throw new Error('connection reset'); } } });
  const res = await h.installEvent(installReq({ slug: 'demo', kind: 'skill', source: 'suggest' }));
  assert.equal(res.status, 204);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /connection reset/);
});

test('an embedding failure is a 500 and nothing printed contains the query, not even nested requestBodyValues', async () => {
  const query = 'my confidential client prompt';
  const apiError = Object.assign(new Error('Bad Request'), {
    name: 'AI_APICallError', url: 'https://gateway.test/v1/embeddings', requestBodyValues: { model: 'x', input: [query] }, statusCode: 400,
  });
  const { h, logged } = eventsHarness({ embed: async () => { throw apiError; } });
  const printed = [];
  const origErr = console.error;
  console.error = (...args) => printed.push(args);
  let res;
  try {
    res = await h.search(req(`/api/search?q=${encodeURIComponent(query)}`, { headers: SUGGEST }));
  } finally {
    console.error = origErr;
  }
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes(query));
  const text = printed.flat().map((a) => `${inspect(a, { depth: null, showHidden: true })} ${JSON.stringify(a)}`).join('\n');
  assert.match(text, /query embedding failed: Bad Request/, 'the wrapped error is what gets printed');
  assert.ok(!text.includes(query), text);
  assert.ok(!text.includes('requestBodyValues'), 'the original error object is not attached');
  assert.ok(!logged.join('\n').includes(query));
});

const CRON_REQ = () => new Request('https://sv.test/api/cron/check-upstream', { headers: { authorization: 'Bearer cron' } });

test('cron runs 90-day event retention for every owner in a first pass, before any upstream work', async () => {
  const order = [];
  const repoFor = (ownerId) => ({
    deleteEventsOlderThan: async (days) => { order.push(['retention', ownerId, days]); return 3; },
    listUpstreamTargets: async () => { order.push(['targets', ownerId]); return []; },
    markUpstream: async () => {},
  });
  const h = createHandlers({ identify: async () => null, repoFor, listOwnerIds: async () => [1, 2], embed: fakeEmbed, env: { CRON_SECRET: 'cron' } });
  const body = await (await h.cron(CRON_REQ())).json();
  assert.deepEqual(order, [['retention', 1, 90], ['retention', 2, 90], ['targets', 1], ['targets', 2]]);
  assert.deepEqual(body, { checked: 0, updates: 0, errors: [] });
});

test('cron: owner 1 failing its upstream listing does not stop owner 2 retention', async () => {
  const retained = [];
  const repoFor = (ownerId) => ({
    deleteEventsOlderThan: async () => { retained.push(ownerId); return 0; },
    listUpstreamTargets: async () => { if (ownerId === 1) throw new Error('statement timeout'); return []; },
    markUpstream: async () => {},
  });
  const h = createHandlers({ identify: async () => null, repoFor, listOwnerIds: async () => [1, 2], embed: fakeEmbed, env: { CRON_SECRET: 'cron' } });
  const origErr = console.error;
  console.error = () => {};
  try {
    await h.cron(CRON_REQ());
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(retained, [1, 2]);
});

test('cron: a retention failure lands in errors and the upstream checks still run', async () => {
  const marked = [];
  const repoFor = (ownerId) => ({
    deleteEventsOlderThan: async () => { if (ownerId === 1) throw new Error('delete timed out'); return 0; },
    listUpstreamTargets: async () => [{ skill_id: ownerId * 10, kind: 'github', url: 'https://github.com/o/r', default_ref: 'HEAD', commit_sha: 'a'.repeat(40) }],
    markUpstream: async (...args) => { marked.push([ownerId, ...args]); },
  });
  const h = createHandlers({
    identify: async () => null, repoFor, listOwnerIds: async () => [1, 2], embed: fakeEmbed, env: { CRON_SECRET: 'cron' },
    fetchImpl: async () => Response.json({ sha: 'a'.repeat(40), commit: { tree: { sha: '1'.repeat(40) } } }),
  });
  const res = await h.cron(CRON_REQ());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.checked, 2);
  assert.deepEqual(body.errors, [{ owner_id: 1, error: 'event retention failed: delete timed out' }]);
  assert.deepEqual(marked.map(([ownerId, skillId]) => [ownerId, skillId]), [[1, 10], [2, 20]]);
});

// --- mapError hook and embed-optional publish (local mode) ---

test('mapError answers a thrown error with its own response; without it the same throw is a 500 internal', async () => {
  const boom = { searchText: async () => { throw new Error('busy'); } };
  const repo = fakeRepo(boom);
  const mapped = createHandlers({
    ...ownerDeps(repo), embed: fakeEmbed, env: {},
    mapError: (e) => (e.message === 'busy' ? Response.json({ error: { code: 'unavailable', message: 'try again' } }, { status: 503 }) : null),
  });
  const res = await mapped.search(req('/api/search?q=x'));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: { code: 'unavailable', message: 'try again' } });
  assert.equal(res.headers.get('cache-control'), 'private, no-store');

  // A mapError that returns null leaves the existing fallbacks in place.
  const passthrough = createHandlers({ ...ownerDeps(repo), embed: fakeEmbed, env: {}, mapError: () => null });
  const plain = createHandlers({ ...ownerDeps(repo), embed: fakeEmbed, env: {} });
  const origErr = console.error;
  console.error = () => {};
  try {
    for (const h of [passthrough, plain]) {
      const r = await h.search(req('/api/search?q=x'));
      assert.equal(r.status, 500);
      assert.equal((await r.json()).error.code, 'internal');
    }
  } finally {
    console.error = origErr;
  }
});

test('publish built without embed stores the manifest chunks as content chunks and calls no embedder or enricher', async () => {
  const repo = fakeRepo();
  let enriched = 0;
  const h = createHandlers({ ...ownerDeps(repo), enrich: async () => { enriched++; return null; }, env: {} });
  const res = await h.publish(publishReq({ ...manifest, chunks: ['alpha', 'beta'] }, pack(files)));
  assert.equal(res.status, 201);
  assert.deepEqual(repo.calls.publish[0].chunks, [{ text: 'alpha', kind: 'content' }, { text: 'beta', kind: 'content' }]);
  assert.equal(enriched, 0);
});
