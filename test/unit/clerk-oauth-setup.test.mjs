import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planClerkSetup,
  applyClerkSetup,
  formatReport,
  issuerFromPublishableKey,
  loadEnvFile,
  resolveInstance,
  main,
} from '../../scripts/clerk-oauth-setup.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ISSUER = 'https://issuer.example.test';
// Key-shaped values are assembled at runtime so no secret-key-shaped literal sits in the source.
const secretKeyOf = (kind, tail) => ['sk', kind, tail].join('_');
const publishableKeyOf = (kind, host) => ['pk', kind, Buffer.from(`${host}$`).toString('base64')].join('_');
const SECRET = secretKeyOf('test', 'SUPERSECRETVALUE0123456789');
const ISSUER_HOST = 'issuer.example.test';
const API_VERSION = '2026-05-12';
const ALL_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'skills:read', 'skills:write'];

const MCP = {
  name: 'headjack-mcp',
  public: true,
  pkce_required: true,
  consent_screen_enabled: true,
  device_authorization_grant_enabled: false,
  scopes: 'skills:read offline_access',
  redirect_uris: ['http://localhost:53436/callback'],
};
const CLI = {
  name: 'headjack-cli',
  public: true,
  pkce_required: true,
  consent_screen_enabled: true,
  device_authorization_grant_enabled: false,
  scopes: 'openid email offline_access skills:read skills:write',
  redirect_uris: [
    'http://127.0.0.1:53437/callback',
    'http://127.0.0.1:53438/callback',
    'http://127.0.0.1:53439/callback',
  ],
};
const DESIRED_SETTINGS = {
  aud_claim_enabled: true,
  oauth_jwt_access_tokens: false,
  dynamic_oauth_client_registration: false,
  client_id_metadata_documents_advertised: false,
  client_id_metadata_documents_only_allow_pre_registered_clients: true,
  client_id_metadata_documents_block_implicitly_allowed_clients: true,
};
const DRIFTED_SETTINGS = Object.fromEntries(Object.entries(DESIRED_SETTINGS).map(([key, value]) => [key, !value]));
const OK_SETTINGS = { object: 'oauth_application_settings', ...DESIRED_SETTINGS };
const A_EMAIL = 'headjack-acceptance-a+clerk_test@example.com';
const B_EMAIL = 'headjack-acceptance-b+clerk_test@example.com';

// An in-memory Clerk Backend API plus a public issuer metadata document. Records every call.
function fakeClerk({ secret = SECRET, scopes = ALL_SCOPES, settings = { object: 'oauth_application_settings', ...DRIFTED_SETTINGS }, apps = [], users = [] } = {}) {
  const state = { settings: { ...settings }, apps: apps.map((a) => ({ ...a })), users: [...users], calls: [], seq: 0 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    state.calls.push({ method, host: u.host, path: u.pathname, search: u.search, body, headers, auth: headers.authorization });
    if (u.origin === ISSUER) {
      assert.equal(method, 'GET');
      assert.equal(u.pathname, '/.well-known/oauth-authorization-server');
      return json({ issuer: ISSUER, scopes_supported: scopes });
    }
    assert.equal(u.origin, 'https://api.clerk.com');
    assert.equal(state.calls.at(-1).auth, `Bearer ${secret}`);
    assert.equal(headers['clerk-api-version'], API_VERSION, `${method} ${u.pathname} must pin the Backend API version`);
    const p = u.pathname;
    if (p === '/v1/instance/oauth_application_settings') {
      if (method === 'GET') return json(state.settings);
      if (method === 'PATCH') { Object.assign(state.settings, body); return json(state.settings); }
    }
    if (p === '/v1/oauth_applications' && method === 'GET') {
      const q = u.searchParams.get('name_query');
      const data = state.apps.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.client_id === q);
      return json({ data, total_count: data.length });
    }
    if (p === '/v1/oauth_applications' && method === 'POST') {
      state.seq += 1;
      const app = { object: 'oauth_application', id: `oa_new${state.seq}`, client_id: `cidnew${state.seq}`, client_secret: 'LEAKED_CLIENT_SECRET', callback_url: '', ...body };
      state.apps.push(app);
      return json(app);
    }
    const m = p.match(/^\/v1\/oauth_applications\/([^/]+)$/);
    if (m) {
      const idx = state.apps.findIndex((a) => a.id === m[1]);
      if (idx < 0) return json({ errors: [{ code: 'resource_not_found', message: 'not found' }] }, 404);
      if (method === 'PATCH') { Object.assign(state.apps[idx], body); return json(state.apps[idx]); }
      if (method === 'DELETE') { const [gone] = state.apps.splice(idx, 1); return json({ object: 'oauth_application', id: gone.id, deleted: true }); }
    }
    if (p === '/v1/users' && method === 'GET') {
      const emails = u.searchParams.getAll('email_address');
      return json(state.users.filter((x) => emails.includes(x.email)).map((x) => ({ id: x.id })));
    }
    if (p === '/v1/users' && method === 'POST') {
      state.seq += 1;
      state.users.push({ id: `user_new${state.seq}`, email: body.email_address[0] });
      return json({ id: `user_new${state.seq}` });
    }
    return json({ errors: [{ code: 'unexpected', message: `${method} ${p}` }] }, 500);
  };
  const writes = () => state.calls.filter((c) => c.method !== 'GET');
  return { state, fetchImpl, writes };
}

const existing = (spec, n) => ({ object: 'oauth_application', id: `oa_${n}`, client_id: `cid${n}`, ...spec });
const matching = () => [existing(MCP, 1), existing(CLI, 2)];
const stateOf = (over = {}) => ({ scopesSupported: ALL_SCOPES, settings: OK_SETTINGS, applications: matching(), ...over });

test('planClerkSetup is empty when scopes, settings and clients already match (idempotent)', () => {
  assert.deepEqual(planClerkSetup(stateOf()), []);
});

test('planClerkSetup creates the missing clients and settings with the exact spec values', () => {
  const plan = planClerkSetup({ scopesSupported: ALL_SCOPES, settings: DRIFTED_SETTINGS, applications: [] });
  assert.deepEqual(plan, [
    { type: 'update-settings', body: DESIRED_SETTINGS },
    { type: 'create-client', name: 'headjack-mcp', body: MCP },
    { type: 'create-client', name: 'headjack-cli', body: CLI },
  ]);
});

test('planClerkSetup updates only drifted fields and turns a device grant off', () => {
  const drifted = existing({ ...CLI, scopes: 'openid email offline_access skills:read', device_authorization_grant_enabled: true, redirect_uris: ['http://127.0.0.1:53437/callback'] }, 2);
  const plan = planClerkSetup(stateOf({ applications: [existing(MCP, 1), drifted] }));
  assert.deepEqual(plan, [{
    type: 'update-client',
    name: 'headjack-cli',
    id: 'oa_2',
    body: { scopes: CLI.scopes, redirect_uris: CLI.redirect_uris, device_authorization_grant_enabled: false },
  }]);
});

for (const key of Object.keys(DESIRED_SETTINGS)) {
  test(`planClerkSetup enforces ${key}=${DESIRED_SETTINGS[key]} when it drifts`, () => {
    const settings = { ...OK_SETTINGS, [key]: !DESIRED_SETTINGS[key] };
    assert.deepEqual(planClerkSetup(stateOf({ settings })), [{ type: 'update-settings', body: { [key]: DESIRED_SETTINGS[key] } }]);
    const absent = { ...OK_SETTINGS };
    delete absent[key];
    assert.deepEqual(planClerkSetup(stateOf({ settings: absent })), [{ type: 'update-settings', body: { [key]: DESIRED_SETTINGS[key] } }]);
  });
}

test('planClerkSetup: a managed name matching several applications blocks everything and names the ids', () => {
  const twin = existing({ ...MCP }, 9);
  const plan = planClerkSetup(stateOf({ settings: DRIFTED_SETTINGS, applications: [existing(MCP, 1), existing(CLI, 2), twin] }));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].type, 'owner-step');
  assert.match(plan[0].text, /headjack-mcp/);
  assert.match(plan[0].text, /oa_1/);
  assert.match(plan[0].text, /oa_9/);
  assert.match(plan[0].text, /Nothing was changed/);
});

test('planClerkSetup compares scopes and redirect URIs as sets, ignoring order', () => {
  const reordered = existing({ ...CLI, scopes: 'skills:write skills:read offline_access email openid', redirect_uris: [...CLI.redirect_uris].reverse() }, 2);
  assert.deepEqual(planClerkSetup(stateOf({ applications: [existing(MCP, 1), reordered] })), []);
});

test('planClerkSetup never produces a body that enables the device grant', () => {
  const plans = [
    planClerkSetup({ scopesSupported: ALL_SCOPES, settings: {}, applications: [] }),
    planClerkSetup(stateOf({ applications: [existing({ ...MCP, device_authorization_grant_enabled: true }, 1), existing({ ...CLI, public: false }, 2)] })),
  ];
  for (const action of plans.flat()) assert.notEqual(action.body?.device_authorization_grant_enabled, true);
});

test('planClerkSetup: a missing custom scope yields only the owner step and no write action', () => {
  const plan = planClerkSetup({ scopesSupported: ['openid', 'email', 'offline_access', 'skills:read'], settings: {}, applications: [] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].type, 'owner-step');
  assert.deepEqual(plan[0].missing, ['skills:write']);
  assert.match(plan[0].text, /Dashboard/);
  assert.match(plan[0].text, /skills:write/);
});

test('applyClerkSetup creates settings and both clients on a bare instance, then a second run writes nothing', async () => {
  const fake = fakeClerk();
  const first = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl });
  assert.equal(first.blocked, false);
  assert.deepEqual(first.actions.map((a) => a.type), ['update-settings', 'create-client', 'create-client']);
  for (const [key, value] of Object.entries(DESIRED_SETTINGS)) assert.equal(fake.state.settings[key], value, key);
  const byName = Object.fromEntries(fake.state.apps.map((a) => [a.name, a]));
  for (const spec of [MCP, CLI]) {
    const app = byName[spec.name];
    assert.equal(app.public, true);
    assert.equal(app.pkce_required, true);
    assert.equal(app.consent_screen_enabled, true);
    assert.equal(app.device_authorization_grant_enabled, false);
    assert.equal(app.scopes, spec.scopes);
    assert.deepEqual(app.redirect_uris, spec.redirect_uris);
  }
  const writesAfterFirst = fake.writes().length;
  const second = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl });
  assert.deepEqual(second.actions, []);
  assert.equal(fake.writes().length, writesAfterFirst);
});

test('applyClerkSetup stops before any write and prints the owner step when a custom scope is missing', async () => {
  const fake = fakeClerk({ scopes: ['openid', 'email', 'offline_access', 'skills:read'] });
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, syntheticUsers: true, deleteClientIds: ['cid1'] });
  assert.equal(report.blocked, true);
  assert.equal(fake.writes().length, 0);
  assert.equal(fake.state.apps.length, 0);
  const text = formatReport(report).join('\n');
  assert.match(text, /skills:write/);
  assert.match(text, /Dashboard/);
  assert.doesNotMatch(text, /skills:read.*(create|missing)/s);
});

test('--dry-run reads everything, reports the plan and sends no write', async () => {
  const fake = fakeClerk();
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.actions.map((a) => a.type), ['update-settings', 'create-client', 'create-client']);
  assert.equal(fake.writes().length, 0);
  assert.ok(fake.state.calls.some((c) => c.path === '/v1/oauth_applications'));
});

test('output never contains the secret key or a client secret', async () => {
  const fake = fakeClerk();
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl });
  const text = formatReport(report).join('\n');
  assert.doesNotMatch(text, /SUPERSECRETVALUE|sk_test_|LEAKED_CLIENT_SECRET/);
  assert.match(text, /headjack-mcp/);
  assert.match(text, /headjack-cli/);
  assert.match(text, /http:\/\/localhost:53436\/callback/);
  assert.match(text, /cidnew1/);
  assert.doesNotMatch(JSON.stringify(report), /SUPERSECRETVALUE|LEAKED_CLIENT_SECRET/);
});

test('an API error message does not leak the secret key', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith(ISSUER)) return new Response(JSON.stringify({ scopes_supported: ALL_SCOPES }));
    return new Response(JSON.stringify({ errors: [{ code: 'authentication_invalid', message: `bad key ${SECRET}` }] }), { status: 401 });
  };
  await assert.rejects(applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl }), (error) => {
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /SUPERSECRETVALUE/);
    return true;
  });
});

test('--synthetic-users with a sk_live_ key is refused before any request', async () => {
  const fake = fakeClerk();
  await assert.rejects(
    applyClerkSetup({ secretKey: secretKeyOf('live', 'abcdef'), issuer: ISSUER, fetchImpl: fake.fetchImpl, syntheticUsers: true }),
    /development instance/,
  );
  assert.equal(fake.state.calls.length, 0);
});

test('--synthetic-users creates the two acceptance users only when absent', async () => {
  const fake = fakeClerk({ users: [{ id: 'user_a', email: A_EMAIL }] });
  const first = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, syntheticUsers: true });
  assert.deepEqual(first.actions.filter((a) => a.type === 'create-user').map((a) => a.email), [B_EMAIL]);
  const post = fake.writes().find((c) => c.path === '/v1/users');
  assert.deepEqual(post.body.email_address, [B_EMAIL]);
  assert.equal(fake.state.users.length, 2);
  const second = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, syntheticUsers: true });
  assert.equal(second.actions.filter((a) => a.type === 'create-user').length, 0);
  assert.equal(fake.state.users.length, 2);
});

test('--dry-run with --synthetic-users plans the users and creates none', async () => {
  const fake = fakeClerk();
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, dryRun: true, syntheticUsers: true });
  assert.deepEqual(report.actions.filter((a) => a.type === 'create-user').map((a) => a.email), [A_EMAIL, B_EMAIL]);
  assert.equal(fake.writes().length, 0);
  assert.equal(fake.state.users.length, 0);
});

test('users are untouched without --synthetic-users', async () => {
  const fake = fakeClerk();
  await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl });
  assert.equal(fake.state.calls.filter((c) => c.path === '/v1/users').length, 0);
});

test('--delete-client resolves the OAuth client id exactly and deletes only that application', async () => {
  const probe = { ...MCP, object: 'oauth_application', id: 'oa_probe', client_id: 'probeClient0001', name: 'Headjack MCP compatibility probe' };
  const decoy = { ...MCP, object: 'oauth_application', id: 'oa_decoy', client_id: 'otherClient', name: 'notes about probeClient0001' };
  const fake = fakeClerk({ settings: OK_SETTINGS, apps: [...matching(), decoy, probe] });
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, deleteClientIds: ['probeClient0001'] });
  const deletes = fake.writes();
  assert.deepEqual(deletes.map((c) => `${c.method} ${c.path}`), ['DELETE /v1/oauth_applications/oa_probe']);
  assert.deepEqual(fake.state.apps.map((a) => a.id).sort(), ['oa_1', 'oa_2', 'oa_decoy']);
  assert.deepEqual(report.actions.filter((a) => a.type === 'delete-client').map((a) => a.clientId), ['probeClient0001']);
  assert.ok(fake.state.calls.some((c) => c.method === 'GET' && c.path === '/v1/oauth_applications' && c.search.includes('name_query=probeClient0001')));
});

test('--delete-client with an unknown client id, or an application id, deletes nothing', async () => {
  const fake = fakeClerk({ settings: OK_SETTINGS, apps: matching() });
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, deleteClientIds: ['nope', 'oa_1'] });
  assert.equal(fake.writes().length, 0);
  assert.equal(fake.state.apps.length, 2);
  assert.deepEqual(report.notFound, ['nope', 'oa_1']);
  assert.match(formatReport(report).join('\n'), /not found/);
});

test('--delete-client under --dry-run looks the application up but deletes nothing', async () => {
  const probe = { ...MCP, object: 'oauth_application', id: 'oa_probe', client_id: 'probeClient0001', name: 'probe' };
  const fake = fakeClerk({ settings: OK_SETTINGS, apps: [...matching(), probe] });
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, dryRun: true, deleteClientIds: ['probeClient0001'] });
  assert.equal(fake.writes().length, 0);
  assert.equal(fake.state.apps.length, 3);
  assert.deepEqual(report.actions.filter((a) => a.type === 'delete-client').map((a) => a.clientId), ['probeClient0001']);
});

test('every Backend API call pins Clerk-API-Version and the public issuer metadata request carries neither it nor Authorization', async () => {
  const fake = fakeClerk();
  await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, syntheticUsers: true });
  const backend = fake.state.calls.filter((c) => c.host === 'api.clerk.com');
  const issuerCalls = fake.state.calls.filter((c) => c.host === ISSUER_HOST);
  assert.ok(backend.length > 5);
  assert.ok(backend.some((c) => c.method !== 'GET'));
  for (const call of backend) assert.equal(call.headers['clerk-api-version'], API_VERSION, `${call.method} ${call.path}`);
  assert.equal(issuerCalls.length, 1);
  assert.equal(issuerCalls[0].headers.authorization, undefined);
  assert.equal(issuerCalls[0].headers['clerk-api-version'], undefined);
  assert.deepEqual(Object.keys(issuerCalls[0].headers), ['accept']);
});

test('the report names the instance issuer and test or live, never a key', async () => {
  const fake = fakeClerk();
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: `${ISSUER}/`, fetchImpl: fake.fetchImpl, dryRun: true });
  const lines = formatReport(report);
  assert.equal(lines[0], `Instance: ${ISSUER} (test)`);
  const liveKey = secretKeyOf('live', 'abcdef0123');
  const live = await applyClerkSetup({ secretKey: liveKey, issuer: ISSUER, fetchImpl: fakeClerk({ secret: liveKey }).fetchImpl, dryRun: true });
  assert.equal(formatReport(live)[0], `Instance: ${ISSUER} (live)`);
  const blocked = fakeClerk({ scopes: ['openid'] });
  const stop = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: blocked.fetchImpl });
  assert.equal(formatReport(stop)[0], `Instance: ${ISSUER} (test)`);
});

test('--delete-client refuses a managed client and writes nothing', async () => {
  const fake = fakeClerk({ settings: DRIFTED_SETTINGS, apps: matching() });
  await assert.rejects(
    applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, deleteClientIds: ['cid2'] }),
    (error) => {
      assert.match(error.message, /headjack-cli/);
      assert.match(error.message, /managed/);
      return true;
    },
  );
  assert.equal(fake.writes().length, 0);
  assert.equal(fake.state.apps.length, 2);
});

test('a deleted application never appears in the report clients', async () => {
  const probe = { ...MCP, object: 'oauth_application', id: 'oa_probe', client_id: 'probeClient', name: 'probe' };
  const fake = fakeClerk({ settings: OK_SETTINGS, apps: [...matching(), probe] });
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, deleteClientIds: ['probeClient'] });
  assert.deepEqual(report.clients.map((c) => c.name), ['headjack-mcp', 'headjack-cli']);
  assert.doesNotMatch(formatReport(report).filter((l) => l.startsWith('  headjack') || l.startsWith('    ')).join('\n'), /probe/);
});

test('duplicate managed names block the run before any write (apply level)', async () => {
  const fake = fakeClerk({ settings: DRIFTED_SETTINGS, apps: [...matching(), existing(CLI, 7)] });
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, syntheticUsers: true });
  assert.equal(report.blocked, true);
  assert.equal(fake.writes().length, 0);
  assert.match(formatReport(report).join('\n'), /headjack-cli.*oa_2.*oa_7|headjack-cli.*oa_7.*oa_2/s);
});

test('a write that fails midway carries the actions already applied, and main prints them', async (t) => {
  const failingFetch = () => {
    const fake = fakeClerk();
    return async (url, init = {}) => {
      if (init.method === 'POST' && init.body && JSON.parse(init.body).name === 'headjack-cli') {
        return new Response(JSON.stringify({ errors: [{ code: 'form_param_invalid' }] }), { status: 422 });
      }
      return fake.fetchImpl(url, init);
    };
  };
  await assert.rejects(applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: failingFetch() }), (error) => {
    assert.match(error.message, /422/);
    assert.deepEqual(error.applied.map((a) => `${a.type} ${a.name ?? ''}`.trim()), ['update-settings', 'create-client headjack-mcp']);
    return true;
  });
  const file = await outsideEnv(t, instanceEnv());
  const io = capture();
  const code = await main(['--env-file', file], { fetchImpl: failingFetch(), ...io });
  assert.equal(code, 1);
  const err = io.err.join('\n');
  assert.match(err, /422/);
  assert.match(err, /Applied before the failure/);
  assert.match(err, /settings: set/);
  assert.match(err, /client headjack-mcp: create/);
  assert.doesNotMatch(err, /headjack-cli: create/);
  assert.doesNotMatch(err, /SUPERSECRETVALUE/);
});

test('device_grant prints unknown when the API does not return a boolean', async () => {
  const noFlag = { ...MCP };
  delete noFlag.device_authorization_grant_enabled;
  const fake = fakeClerk({ settings: OK_SETTINGS, apps: [existing(noFlag, 1), existing(CLI, 2)] });
  const report = await applyClerkSetup({ secretKey: SECRET, issuer: ISSUER, fetchImpl: fake.fetchImpl, dryRun: true });
  const text = formatReport(report).join('\n');
  assert.match(text, /consent_screen=true device_grant=unknown/);
  assert.match(text, /device_grant=false/);
  assert.doesNotMatch(text, /device_grant=(undefined|null)/);
});

test('issuerFromPublishableKey decodes the frontend API host', () => {
  const key = `pk_test_${Buffer.from('dev-instance.clerk.example.test$').toString('base64')}`;
  assert.equal(issuerFromPublishableKey(key), 'https://dev-instance.clerk.example.test');
  const live = `pk_live_${Buffer.from('clerk.prod-instance.example.test$').toString('base64')}`;
  assert.equal(issuerFromPublishableKey(live), 'https://clerk.prod-instance.example.test');
  assert.throws(() => issuerFromPublishableKey('not-a-key'), /publishable key/);
});

const instanceEnv = ({ secret = SECRET, publishable = publishableKeyOf('test', ISSUER_HOST), issuer = ISSUER } = {}) =>
  [`CLERK_SECRET_KEY=${secret}`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${publishable}`, issuer ? `HEADJACK_AUTH_SERVER_URL=${issuer}` : ''].join('\n') + '\n';

async function outsideEnv(t, text) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sv-clerk-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env.clerk');
  await writeFile(file, text, { mode: 0o600 });
  return file;
}

test('loadEnvFile reads CLERK_SECRET_KEY from the file and never from process.env', async (t) => {
  const file = await outsideEnv(t, `# comment\nexport CLERK_SECRET_KEY="${SECRET}"\nHEADJACK_AUTH_SERVER_URL='${ISSUER}'\nOTHER=1\n`);
  const previous = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_SECRET_KEY = secretKeyOf('test', 'FROM_PROCESS_ENV');
  t.after(() => { if (previous === undefined) delete process.env.CLERK_SECRET_KEY; else process.env.CLERK_SECRET_KEY = previous; });
  const env = await loadEnvFile(file);
  assert.equal(env.CLERK_SECRET_KEY, SECRET);
  assert.equal(env.HEADJACK_AUTH_SERVER_URL, ISSUER);
  const empty = await outsideEnv(t, 'OTHER=1\n');
  await assert.rejects(loadEnvFile(empty), /CLERK_SECRET_KEY/);
});

test('loadEnvFile refuses an env file inside the repository', async () => {
  await assert.rejects(loadEnvFile(path.join(REPO_ROOT, 'package.json')), /inside the repository/);
  await assert.rejects(loadEnvFile(path.join(REPO_ROOT, 'does', 'not', 'exist.env')), /inside the repository/);
  await assert.rejects(loadEnvFile(path.join(REPO_ROOT, 'scripts', '..', 'package.json')), /inside the repository/);
});

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

test('main exits 2 on an env file inside the repo and prints neither secret nor path contents', async () => {
  const io = capture();
  const fake = fakeClerk();
  const code = await main(['--env-file', path.join(REPO_ROOT, 'package.json')], { fetchImpl: fake.fetchImpl, ...io });
  assert.equal(code, 2);
  assert.match(io.err.join('\n'), /inside the repository/);
  assert.equal(fake.state.calls.length, 0);
});

test('main requires --env-file and rejects unknown flags', async () => {
  for (const argv of [[], ['--nope']]) {
    const io = capture();
    assert.equal(await main(argv, { fetchImpl: fakeClerk().fetchImpl, ...io }), 2);
    assert.ok(io.err.length > 0);
  }
});

test('main runs end to end from an env file outside the repo and prints non-secret results', async (t) => {
  const file = await outsideEnv(t, instanceEnv());
  const io = capture();
  const fake = fakeClerk();
  const code = await main(['--env-file', file, '--dry-run', '--delete-client', 'cidx', '--delete-client', 'cidy'], { fetchImpl: fake.fetchImpl, ...io });
  assert.equal(code, 0);
  assert.equal(fake.writes().length, 0);
  const text = io.out.join('\n');
  assert.match(text, /dry run/i);
  assert.doesNotMatch(text, /SUPERSECRETVALUE|LEAKED/);
  assert.deepEqual(fake.state.calls.filter((c) => c.search.includes('name_query')).map((c) => new URLSearchParams(c.search).get('name_query')), ['cidx', 'cidy']);
});

test('main exits 1 and prints the owner step when a custom scope is missing', async (t) => {
  const file = await outsideEnv(t, instanceEnv());
  const io = capture();
  const fake = fakeClerk({ scopes: ['openid', 'email', 'offline_access'] });
  const code = await main(['--env-file', file], { fetchImpl: fake.fetchImpl, ...io });
  assert.equal(code, 1);
  assert.equal(fake.writes().length, 0);
  assert.match(io.out.join('\n'), /skills:read, skills:write|skills:read and skills:write/);
});

test('resolveInstance derives the issuer and mode from the publishable key and the secret key together', () => {
  const pk = publishableKeyOf('test', ISSUER_HOST);
  assert.deepEqual(resolveInstance({ CLERK_SECRET_KEY: SECRET, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk }), { issuer: ISSUER, mode: 'test' });
  const live = resolveInstance({ CLERK_SECRET_KEY: secretKeyOf('live', 'abc123'), NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKeyOf('live', ISSUER_HOST) });
  assert.deepEqual(live, { issuer: ISSUER, mode: 'live' });
  assert.equal(resolveInstance({ CLERK_SECRET_KEY: SECRET, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk, HEADJACK_AUTH_SERVER_URL: `${ISSUER}/` }).issuer, ISSUER);
});

test('resolveInstance refuses an HEADJACK_AUTH_SERVER_URL that names another instance', () => {
  const env = { CLERK_SECRET_KEY: SECRET, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKeyOf('test', ISSUER_HOST), HEADJACK_AUTH_SERVER_URL: 'https://other.example.test' };
  assert.throws(() => resolveInstance(env), (error) => {
    assert.match(error.message, /HEADJACK_AUTH_SERVER_URL/);
    assert.match(error.message, /another instance|differs/);
    return true;
  });
});

test('resolveInstance refuses a test secret key with a live publishable key and the reverse', () => {
  assert.throws(() => resolveInstance({ CLERK_SECRET_KEY: SECRET, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKeyOf('live', ISSUER_HOST) }), /test.*live|live.*test/);
  assert.throws(() => resolveInstance({ CLERK_SECRET_KEY: secretKeyOf('live', 'abc123'), NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKeyOf('test', ISSUER_HOST) }), /test.*live|live.*test/);
});

test('resolveInstance requires a publishable key and a recognisable secret key', () => {
  assert.throws(() => resolveInstance({ CLERK_SECRET_KEY: SECRET }), /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  assert.throws(() => resolveInstance({ CLERK_SECRET_KEY: 'whatever', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKeyOf('test', ISSUER_HOST) }), /CLERK_SECRET_KEY/);
});

test('main exits 2 before any request on a test/live mismatch or a different HEADJACK_AUTH_SERVER_URL', async (t) => {
  const cases = [
    instanceEnv({ publishable: publishableKeyOf('live', ISSUER_HOST) }),
    instanceEnv({ issuer: 'https://other.example.test' }),
  ];
  for (const text of cases) {
    const file = await outsideEnv(t, text);
    const io = capture();
    const fake = fakeClerk();
    assert.equal(await main(['--env-file', file], { fetchImpl: fake.fetchImpl, ...io }), 2);
    assert.equal(fake.state.calls.length, 0);
    assert.doesNotMatch(io.err.join('\n'), /SUPERSECRETVALUE/);
  }
});

test('main prints the issuer and test/live first, with the issuer derived from the publishable key', async (t) => {
  const file = await outsideEnv(t, instanceEnv({ issuer: '' }));
  const io = capture();
  const fake = fakeClerk();
  assert.equal(await main(['--env-file', file, '--dry-run'], { fetchImpl: fake.fetchImpl, ...io }), 0);
  assert.equal(io.out[0], `Instance: ${ISSUER} (test)`);
});

test('loadEnvFile refuses a sibling named like a parent reference inside the repository', async () => {
  await assert.rejects(loadEnvFile(path.join(REPO_ROOT, '..clerk.env')), /inside the repository/);
  await assert.rejects(loadEnvFile(path.join(REPO_ROOT, '..', path.basename(REPO_ROOT), '..clerk.env')), /inside the repository/);
});

test('loadEnvFile refuses a file under any directory that holds a .git entry (other checkouts, worktrees)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sv-clerk-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'checkout', '.git'), { recursive: true });
  await mkdir(path.join(root, 'worktree', 'nested', 'deeper'), { recursive: true });
  await writeFile(path.join(root, 'worktree', '.git'), 'gitdir: /elsewhere\n');
  for (const file of [path.join(root, 'checkout', 'dev.env'), path.join(root, 'worktree', 'nested', 'deeper', 'dev.env')]) {
    await writeFile(file, `CLERK_SECRET_KEY=${SECRET}\n`, { mode: 0o600 });
    await assert.rejects(loadEnvFile(file), /\.git/);
  }
  await assert.rejects(loadEnvFile(path.join(root, 'checkout', 'not-created-yet', 'dev.env')), /\.git/);
  const clean = path.join(root, 'clean.env');
  await writeFile(clean, `CLERK_SECRET_KEY=${SECRET}\n`, { mode: 0o600 });
  assert.equal((await loadEnvFile(clean)).CLERK_SECRET_KEY, SECRET);
});
