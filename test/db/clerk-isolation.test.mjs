import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createClerkClient } from '@clerk/backend';
import { clerkIdentityResolver } from '../../lib/clerk-identity.mjs';
import { createIdentity } from '../../lib/identity.mjs';
import { createDb } from '../../lib/db.mjs';
import { createHandlers } from '../../lib/handlers.mjs';
import { repoForOwner } from '../../lib/repo.mjs';
import { appPool, migratedPg } from '../pglite.mjs';

const origin = 'https://vault.test';
const issuer = 'https://clerk.vault.test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: 'spki', format: 'pem' });
const client = createClerkClient({ publishableKey: `pk_live_${Buffer.from('clerk.vault.test$').toString('base64')}`, secretKey: 'sk_live_fixture' });
const users = new Map(['user_A', 'user_B'].map(id => [id, { id, banned: false, locked: false, primaryEmailAddressId: `email_${id}`, emailAddresses: [{ id: `email_${id}`, verification: { status: 'verified' } }] }]));
let pg, db, identity, h;
function token(userId, extra = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'fixture' })}.${b64({ sub: userId, sid: `sess_${userId}`, iss: issuer, azp: origin, iat: now, nbf: now - 5, exp: now + 60, v: 2, ...extra })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
const req = (jwt, path = '/api/skills/twin') => new Request(`${origin}${path}`, { headers: { authorization: `Bearer ${jwt}`, 'x-owner-id': '1' } });

before(async () => {
  pg = await migratedPg();
  db = createDb(appPool(pg));
  const resolve = clerkIdentityResolver({ env: { CLERK_AUTHORIZED_PARTIES: origin }, enabled: async () => true, getClient: async () => ({
    // Real SDK signature, expiry and authorized-party verification. Only the remote account/session reads are local.
    authenticateRequest: (r, options) => client.authenticateRequest(r, { ...options, jwtKey }),
    users: { getUser: async (id) => users.get(id) },
    sessions: { getSession: async (id) => ({ id, userId: id.slice(5), status: 'active' }) },
  }) });
  identity = createIdentity({ resolvers: [resolve], resolveOwner: db.resolveOwner });
  h = createHandlers({ identify: identity.identify, repoFor: id => repoForOwner(db.withOwner, id), env: {}, embed: async () => [] });
  for (const id of ['user_A', 'user_B']) {
    const who = await identity.identify(req(token(id)));
    assert.ok(who, `SDK accepted signed session for ${id}`);
    await db.withOwner(who.ownerId, tx => tx.query("insert into skills (slug,name,description,kind) values ('twin','twin',$1,'skill')", [`private ${id}`]));
  }
});
after(async () => { await pg?.close(); });

test('real SDK session verification + Postgres RLS returns only the authenticated user copy', async () => {
  for (const id of ['user_A', 'user_B']) {
    const res = await h.getSkill(req(token(id)));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).skill.description, `private ${id}`);
  }
  const owners = await pg.query("select ref_id from owners where ref_id like 'clerk:%' order by ref_id");
  assert.deepEqual(owners.rows.map(r => r.ref_id), ['clerk:user_A', 'clerk:user_B']);
});

test('forged signature, expired JWT and foreign authorized party cannot read data or create owners', async () => {
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const jwt of [token('user_C', {}, wrongKey), token('user_C', { exp: 1 }), token('user_C', { azp: 'https://evil.test' })]) {
    assert.equal((await h.getSkill(req(jwt))).status, 401);
  }
  assert.equal((await pg.query("select count(*)::int n from owners where ref_id = 'clerk:user_C'")).rows[0].n, 0);
});

test('banning an already mapped user blocks the next request despite cached owner mapping', async () => {
  users.get('user_A').banned = true;
  assert.equal((await h.getSkill(req(token('user_A')))).status, 401);
  users.get('user_A').banned = false;
});

test('real SDK cookie sessions work and cross-origin writes return 403 before touching data', async () => {
  const headers = { cookie: `__session=${token('user_A')}; __client_uat=${Math.floor(Date.now() / 1000)}` };
  const res = await h.getSkill(new Request(`${origin}/api/skills/twin`, { headers }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).skill.description, 'private user_A');
  const bad = await h.publish(new Request(`${origin}/api/skills`, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' } }));
  assert.equal(bad.status, 403);
  const who = await identity.identify(new Request(`${origin}/api/skills`, { method: 'POST', headers: { ...headers, origin } }));
  assert.equal(who.subject.refId, 'clerk:user_A');
});


test('real SDK cookie catalog lists and counts each user despite spoofed owner headers', async () => {
  for (const id of ['user_A', 'user_B']) {
    const headers = { cookie: `__session=${token(id)}; __client_uat=${Math.floor(Date.now() / 1000)}`, 'x-owner-id': '1' };
    const res = await h.listSkills(new Request(`${origin}/api/skills`, { headers }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.limit, 24);
    assert.equal(body.offset, 0);
    assert.deepEqual(body.skills.map(s => s.description), [`private ${id}`]);
    assert.equal(body.skills[0].has_approved_version, false);
  }
});
