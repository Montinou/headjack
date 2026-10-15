import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, LEGACY_OWNER_REF } from '../../lib/identity.mjs';
import * as identityModule from '../../lib/identity.mjs';
import { bearerResolver } from '../server-helpers.mjs';

const req = (auth) => new Request('https://sv.test/api/search?q=x', auth ? { headers: { authorization: auth } } : {});

// The bearer resolver is a test fixture; production resolves identity through Clerk only.
function harness(token = 't0k3n', extra = []) {
  const resolved = [];
  const identity = createIdentity({
    resolvers: [bearerResolver(token), ...extra],
    resolveOwner: async (kind, refId) => { resolved.push([kind, refId]); return 5; },
  });
  return { identity, resolved };
}

test('a resolved subject maps to its owner through resolve_owner(user, legacy:v1)', async () => {
  const { identity, resolved } = harness();
  const who = await identity.identify(req('Bearer t0k3n'));
  assert.equal(who.ownerId, 5);
  assert.deepEqual(who.subject, { kind: 'user', refId: LEGACY_OWNER_REF, via: 'test-bearer' });
  assert.deepEqual(resolved, [['user', 'legacy:v1']]);
});

test('the server no longer exports a legacy token resolver', () => {
  assert.equal(identityModule.legacyTokenResolver, undefined);
});

test('LEGACY_OWNER_REF cannot collide with a Better Auth id ([A-Za-z0-9]{32})', () => {
  assert.equal(LEGACY_OWNER_REF, 'legacy:v1');
  assert.doesNotMatch(LEGACY_OWNER_REF, /^[A-Za-z0-9]+$/);
});

test('no header, a wrong token, a non-Bearer scheme or an empty token identify nobody', async () => {
  const { identity, resolved } = harness();
  for (const auth of [null, 'Bearer nope', 'Basic dDBrM246', 't0k3n', 'Bearer ', 'bearer t0k3n']) {
    assert.equal(await identity.identify(req(auth)), null, String(auth));
  }
  const unset = harness('');
  assert.equal(await unset.identity.identify(req('Bearer ')), null);
  assert.deepEqual([...resolved, ...unset.resolved], []);
});

test('owner ids are cached per subject, so resolve_owner runs once per process and subject', async () => {
  const { identity, resolved } = harness();
  await identity.identify(req('Bearer t0k3n'));
  await identity.identify(req('Bearer t0k3n'));
  assert.equal(resolved.length, 1);
});

test('resolvers run in order and the first subject wins (the stage-2 extension point)', async () => {
  const later = async (r) => (r.headers.get('authorization') === 'Bearer sk_live' ? { kind: 'user', refId: 'u123', via: 'api-key' } : null);
  const { identity, resolved } = harness('t0k3n', [later]);
  assert.equal((await identity.identify(req('Bearer sk_live'))).subject.via, 'api-key');
  assert.deepEqual(resolved, [['user', 'u123']]);
});

test('a resolveOwner failure propagates (the handler turns it into a 500), it never becomes an anonymous owner', async () => {
  const identity = createIdentity({ resolvers: [bearerResolver('t')], resolveOwner: async () => { throw new Error('db down'); } });
  await assert.rejects(identity.identify(req('Bearer t')), /db down/);
});
