// Spec §9 isolation test at the HTTP layer: two owners with identical slugs, real handlers, real RLS.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { createHandlers } from '../../lib/handlers.mjs';
import { createIdentity } from '../../lib/identity.mjs';
import { repoForOwner } from '../../lib/repo.mjs';
import { pack, unpack } from '../../lib/tar.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { file } from '../helpers.mjs';
import { bearerResolver } from '../server-helpers.mjs';
import { appPool, migratedPg } from '../pglite.mjs';

const TOKEN_A = 'token-a';
const TOKEN_B = 'token-b';
const embed = async (texts) => texts.map(() => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)));
let h;
const twinSha = {};
let cronBody;

const req = (token, path, init = {}) => new Request(`https://sv.test${path}`, { ...init, headers: { authorization: `Bearer ${token}` } });
async function publish(token, slug, body, extra = {}) {
  const files = [file('SKILL.md', `---\nname: ${slug}\ndescription: ${body}\n---\n${body}\n`)];
  const form = new FormData();
  form.set('manifest', JSON.stringify({ slug, name: slug, description: body, kind: 'skill', status: 'approved', sha256: hashFiles(files), chunks: [body], source: { kind: 'local' }, ...extra }));
  form.set('tarball', new Blob([pack(files)]), `${slug}.tgz`);
  const res = await h.publish(req(token, '/api/skills', { method: 'POST', body: form }));
  assert.equal(res.status, 201, await res.clone().text());
  return hashFiles(files);
}

before(async () => {
  const pg = await migratedPg();
  const db = createDb(appPool(pg));
  // Test resolvers: TOKEN_A is the initial owner (A); a stand-in for the Clerk resolver maps token-b to owner B.
  const tokenB = async (r) => (r.headers.get('authorization') === `Bearer ${TOKEN_B}` ? { kind: 'user', refId: 'user-b', via: 'test' } : null);
  const identity = createIdentity({ resolvers: [bearerResolver(TOKEN_A), tokenB], resolveOwner: db.resolveOwner });
  h = createHandlers({
    identify: identity.identify,
    repoFor: (ownerId) => repoForOwner(db.withOwner, ownerId),
    listOwnerIds: db.listOwnerIds,
    embed,
    env: { CRON_SECRET: 'cron' },
    // GitHub commit JSON: HEAD is c… with a root tree that differs from the reviewed commit's.
    fetchImpl: async (url) => Response.json({ sha: url.endsWith('/commits/HEAD') ? 'c'.repeat(40) : 'a'.repeat(40), commit: { tree: { sha: url.endsWith('/commits/HEAD') ? '2'.repeat(40) : '1'.repeat(40) } } }),
  });
  twinSha[TOKEN_A] = await publish(TOKEN_A, 'twin', 'owner a secret recipe');
  twinSha[TOKEN_B] = await publish(TOKEN_B, 'twin', 'owner b private notes');
  // Owner B has data on both updates views: a grandfathered version, and a github skill whose upstream moves.
  await publish(TOKEN_B, 'b-only', 'owner b zebra pipeline', { review_notes: 'grandfathered: pre-review import' });
  await publish(TOKEN_B, 'b-upstream', 'owner b tracked upstream',
    { source: { kind: 'github', url: 'https://github.com/owner-b/tracked' }, commit_sha: 'a'.repeat(40) });
  // The cron visits every owner through RLS; fetchImpl reports a changed root tree, so only B's skill gets an update.
  const cron = await h.cron(new Request('https://sv.test/api/cron/check-upstream', { headers: { authorization: 'Bearer cron' } }));
  assert.equal(cron.status, 200);
  cronBody = await cron.json();
});

test('the same slug resolves to each owner’s own skill on every read route', async () => {
  for (const [token, needle] of [[TOKEN_A, 'secret recipe'], [TOKEN_B, 'private notes']]) {
    const skill = (await (await h.getSkill(req(token, '/api/skills/twin'))).json()).skill;
    assert.match(skill.description, new RegExp(needle));
    const res = await h.download(req(token, '/api/skills/twin/download'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-skill-sha256'), twinSha[token]);
    const skillMd = unpack(Buffer.from(await res.arrayBuffer())).find((f) => f.path === 'SKILL.md');
    assert.match(skillMd.data.toString('utf8'), new RegExp(needle));
    const versions = (await (await h.versions(req(token, '/api/skills/twin/versions'))).json()).versions;
    assert.equal(versions.length, 1);
  }
});

test('owner A gets 404 for owner B’s slug on every route and never sees it in search or updates', async () => {
  for (const path of ['/api/skills/b-only', '/api/skills/b-only/download', '/api/skills/b-only/versions']) {
    const handler = path.endsWith('download') ? h.download : path.endsWith('versions') ? h.versions : h.getSkill;
    assert.equal((await handler(req(TOKEN_A, path))).status, 404, path);
  }
  const results = (await (await h.search(req(TOKEN_A, '/api/search?q=zebra%20pipeline&k=25'))).json()).results;
  assert.ok(!results.some((r) => r.slug === 'b-only'));
  assert.ok(results.every((r) => !/owner b/.test(r.description)));
  const updates = async (token, qs = '') => (await (await h.updates(req(token, `/api/updates${qs}`))).json()).updates;
  // B's own views are non-empty, so A's empty ones are a real isolation check.
  assert.deepEqual(cronBody, { checked: 1, updates: 1, errors: [] });
  assert.deepEqual((await updates(TOKEN_B)).map((u) => u.slug), ['b-upstream']);
  assert.deepEqual((await updates(TOKEN_B, '?grandfathered=1')).map((u) => u.slug), ['b-only']);
  assert.deepEqual(await updates(TOKEN_A), []);
  assert.deepEqual(await updates(TOKEN_A, '?grandfathered=1'), []);
});

test('an unknown token is 401 on every route, before any database work', async () => {
  for (const fn of [h.search, h.getSkill, h.download, h.versions, h.updates, h.publish]) {
    assert.equal((await fn(req('nope', '/api/skills/twin?q=x'))).status, 401);
  }
});
