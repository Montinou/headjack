import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { app, openOwnerRepo, isFlagOverridden } from '../../lib/app.mjs';
import { REPO_METHODS } from '../../lib/repo.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('plain Node can import lib/app.mjs without loading the Flags SDK', () => {
  const child = spawnSync(process.execPath, ['--import', './test/block-flags.mjs', '--input-type=module', '-e', "await import('./lib/app.mjs');"], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
});

test('the flags blocker makes a Flags SDK import fail', () => {
  const child = spawnSync(process.execPath, ['--import', './test/block-flags.mjs', '--input-type=module', '-e', "await import('flags/next');"], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /blocked by test\/block-flags\.mjs: flags\/next/);
});

function fakeOpen(resolved = 3) {
  const calls = { resolve: [], ended: 0, owners: [] };
  const open = () => ({
    resolveOwner: async (kind, ref) => { calls.resolve.push([kind, ref]); return resolved; },
    withOwner: async (ownerId, fn) => { calls.owners.push(ownerId); return fn({ query: async () => ({ rows: [] }) }); },
    end: async () => { calls.ended++; },
  });
  return { open, calls };
}

test('scripts default to the initial owner, resolved through resolve_owner(user, legacy:v1)', async () => {
  const { open, calls } = fakeOpen(3);
  const vault = await openOwnerRepo({}, open);
  assert.equal(vault.ownerId, 3);
  assert.deepEqual(calls.resolve, [['user', 'legacy:v1']]);
  assert.deepEqual(Object.keys(vault.repo).sort(), [...REPO_METHODS].sort());
  await vault.repo.listUpdates({});
  assert.deepEqual(calls.owners, [3]);
});

test('maintenance owner comes from HEADJACK_OWNER_ID', async () => {
  const { open, calls } = fakeOpen(3);
  assert.equal((await openOwnerRepo({ HEADJACK_OWNER_ID: '9' }, open)).ownerId, 9);
  assert.deepEqual(calls.resolve, []);
});

test('HEADJACK_OWNER_ID picks another owner without resolving; a bad value fails and closes the pool', async () => {
  const { open, calls } = fakeOpen();
  assert.equal((await openOwnerRepo({ HEADJACK_OWNER_ID: '9' }, open)).ownerId, 9);
  assert.deepEqual(calls.resolve, []);
  for (const bad of ['0', '-2', 'x', '1.5']) {
    await assert.rejects(openOwnerRepo({ HEADJACK_OWNER_ID: bad }, open), /HEADJACK_OWNER_ID/);
  }
  assert.equal(calls.ended, 4);
});

// The production override check: a request that pins its flag values by hand (an evaluation run) must log no exposure.
// handlers.test.mjs injects its own predicate, so this is the only guard on the real cookie name.
test('isFlagOverridden is true only for a request carrying the flag-override cookie', () => {
  const req = (headers) => new Request('https://sv.test/api/search?q=x', { headers });
  assert.equal(isFlagOverridden(req({ cookie: 'theme=dark; vercel-flag-overrides=abc123' })), true);
  assert.equal(isFlagOverridden(req({ cookie: 'vercel-flag-overrides=abc123' })), true);
  assert.equal(isFlagOverridden(req({ cookie: 'theme=dark; session=1' })), false);
  assert.equal(isFlagOverridden(req({ cookie: 'vercel-flag-overrides-not=1' })), false);
  assert.equal(isFlagOverridden(req({})), false);
});

test('app() hands the handlers factory the real isFlagOverridden predicate', () => {
  const source = readFileSync(new URL('../../lib/app.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('createHandlers({');
  assert.ok(start > 0, 'app() calls createHandlers');
  const call = source.slice(start, source.indexOf('\n  });', start));
  assert.match(call, /\boverridden: isFlagOverridden,/);
});

// Order-dependent: app() builds its handlers once and caches them at module level (lib/app.mjs), reading process.env
// on that first call. This is the only test in the file that calls app(), so it sets the environment it needs first;
// a second app() caller (or one in an earlier test) would reuse or pre-empt these handlers.
test('the old single-owner bearer value is 401 with no Clerk credential, even when HEADJACK_TOKEN is still set', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { HEADJACK_TOKEN: 'old-owner-bearer', DATABASE_URL_APP: 'postgres://headjack_app:x' + '@127.0.0.1:9/none' });
  for (const name of ['CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY']) delete process.env[name];
  try {
    const res = await app().search(new Request('https://sv.test/api/search?q=x', { headers: { authorization: 'Bearer old-owner-bearer' } }));
    assert.equal(res.status, 401);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
