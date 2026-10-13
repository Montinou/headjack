import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../../lib/handlers.mjs';
import { ForbiddenError } from '../../lib/errors.mjs';

const req = (query = '') => new Request(`https://vault.test/api/skills${query}`);
function make({ identify = async () => ({ ownerId: 7 }), repo = {} } = {}) {
  const calls = [];
  const h = createHandlers({ identify, repoFor: owner => {
    assert.equal(owner, 7);
    return { listSkills: async options => { calls.push(options); return { skills: [], total: 0 }; }, ...repo };
  }, env: {}, embed: async () => [] });
  return { h, calls };
}

test('anonymous catalog requests return 401 before reaching the repo', async () => {
  const { h, calls } = make({ identify: async () => null });
  assert.equal((await h.listSkills(req())).status, 401);
  assert.deepEqual(calls, []);
});

test('forbidden catalog requests return 403 before reaching the repo', async () => {
  const { h, calls } = make({ identify: async () => { throw new ForbiddenError('scope denied'); } });
  assert.equal((await h.listSkills(req())).status, 403);
  assert.deepEqual(calls, []);
});

test('catalog defaults to 24 rows at offset 0', async () => {
  const { h, calls } = make();
  const res = await h.listSkills(req());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skills: [], total: 0, limit: 24, offset: 0 });
  assert.deepEqual(calls, [{ kind: undefined, tags: [], limit: 24, offset: 0 }]);
});

for (const kind of ['skill', 'plugin']) {
  test(`catalog accepts kind ${kind} with maximum limit and safe integer offset`, async () => {
    const { h, calls } = make();
    const res = await h.listSkills(req(`?kind=${kind}&limit=100&offset=9007199254740991`));
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ kind, tags: [], limit: 100, offset: 9007199254740991 }]);
  });
}
for (const value of ['', 'other', 'Skill', 'skill,plugin']) {
  test(`catalog rejects invalid kind ${JSON.stringify(value)}`, async () => {
    const { h, calls } = make();
    assert.equal((await h.listSkills(req(`?kind=${encodeURIComponent(value)}`))).status, 400);
    assert.deepEqual(calls, []);
  });
}
for (const [key, values] of [
  ['limit', ['', 'x', '1.5', '-1', '0', '101', '9007199254740992', '1e2', '0x10', ' 24 ']],
  ['offset', ['', 'x', '1.5', '-1', '9007199254740992', '1e2', '0x10', ' 0 ']],
]) {
  for (const value of values) {
    test(`catalog rejects malformed or out-of-range ${key} ${JSON.stringify(value)}`, async () => {
      const { h, calls } = make();
      const res = await h.listSkills(req(`?${key}=${encodeURIComponent(value)}`));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'bad_request');
      assert.deepEqual(calls, []);
    });
  }
}

test('catalog normalizes comma-separated and repeated tags, deduplicating before the cap', async () => {
  const { h, calls } = make();
  const res = await h.listSkills(req('?tag=Three.js,Writing_Style&tag=threejs&tag=,'));
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0].tags, ['threejs', 'writing-style']);
  assert.equal((await h.listSkills(req('?tag=a,b,c,d,e,f,g,h'))).status, 200);
});
for (const tags of ['a,b,c,d,e,f,g,h,i', '!!!']) {
  test(`catalog rejects invalid tags ${tags}`, async () => {
    const { h, calls } = make();
    assert.equal((await h.listSkills(req(`?tag=${tags}`))).status, 400);
    assert.deepEqual(calls, []);
  });
}


const privateRoutes = [
  ['search', '/api/search?q=x'], ['getSkill', '/api/skills/item'],
  ['versions', '/api/skills/item/versions'], ['reviews', '/api/skills/item/reviews'],
  ['updates', '/api/updates'], ['download', '/api/skills/item/download'],
  ['publish', '/api/skills'], ['installEvent', '/api/events/install'],
];
for (const [method, path] of privateRoutes) {
  for (const [label, identify, status] of [
    ['anonymous', async () => null, 401],
    ['forbidden', async () => { throw new ForbiddenError('denied'); }, 403],
    ['identity failure', async () => { throw new Error('fixture failure'); }, 500],
  ]) {
    test(`${method} ${label} response is private and uncached`, async t => {
      if (status === 500) t.mock.method(console, 'error', () => {});
      const { h } = make({ identify });
      const res = await h[method](new Request(`https://vault.test${path}`));
      assert.equal(res.status, status);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assert.equal(res.headers.get('content-type'), 'application/json');
    });
  }
}
const readableRoutes = privateRoutes.slice(0, 6);
for (const [method, path] of readableRoutes) {
  test(`${method} success keeps content headers and is private and uncached`, async () => {
    const { h } = make({ repo: {
      searchVector: async () => [], searchText: async () => [], getSkillsByIds: async () => [],
      getSkill: async () => ({ slug: 'item' }), listVersions: async () => [], listReviews: async () => [],
      listUpdates: async () => [],
      getTarball: async () => ({ kind: 'skill', plugin_slug: null, sha256: 'f'.repeat(64), tarball: Buffer.from('TGZ') }),
    } });
    const res = await h[method](new Request(`https://vault.test${path}`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('content-type'), method === 'download' ? 'application/gzip' : 'application/json');
    if (method === 'download') {
      assert.equal(res.headers.get('x-skill-sha256'), 'f'.repeat(64));
      assert.equal(await res.text(), 'TGZ');
    }
  });
  test(`${method} repo failure is private and uncached`, async t => {
    t.mock.method(console, 'error', () => {});
    const fail = async () => { throw new Error('fixture failure'); };
    const { h } = make({ repo: { searchVector: fail, searchText: fail, getSkill: fail, listUpdates: fail, getTarball: fail } });
    const res = await h[method](new Request(`https://vault.test${path}`));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });
}
for (const [method, path, repo, status] of [
  ['search', '/api/search', {}, 400],
  ['getSkill', '/api/skills/missing', { getSkill: async () => null }, 404],
  ['versions', '/api/skills/missing/versions', { getSkill: async () => null }, 404],
  ['reviews', '/api/skills/missing/reviews', { getSkill: async () => null }, 404],
  ['download', '/api/skills/missing/download', { getTarball: async () => null }, 404],
  ['download', '/api/skills/item/download', { getTarball: async () => ({ kind: 'plugin' }) }, 409],
  ['download', '/api/skills/item/download', { getTarball: async () => ({ kind: 'skill', tarball: null }) }, 404],
]) {
  test(`${method} handled failure ${status} is private and uncached`, async () => {
    const { h } = make({ repo });
    const res = await h[method](new Request(`https://vault.test${path}`));
    assert.equal(res.status, status);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });
}

test('cron responses retain their existing cache policy', async () => {
  const { h } = make();
  const res = await h.cron(new Request('https://vault.test/api/cron/check-upstream'));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), null);
});
