import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mcpHttpFixture, MCP_TEST_SLUGS, MCP_TEST_CONFIG, fixtureBody, fixtureSource } from '../mcp-http-fixture.mjs';
import { createRepo } from '../../lib/repo.mjs';

let fixture;
before(async () => { fixture = await mcpHttpFixture(); });
after(async () => { await fixture?.close(); });
function content(result) {
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  assert.doesNotMatch(JSON.stringify(result), /email_address|fixture\.invalid|sk_test|oat_user|grant_user|ownerId|owner_id|sessionId|refId|access_token|primaryEmail|privateMetadata|publicMetadata|unsafeMetadata|banned|locked|private .*diagnostic/);
  return result.structuredContent;
}
async function call(client, name, args = {}) { return content(await client.callTool({ name, arguments: args })); }
async function denied(token, expected = 401, extraHeaders = {}) {
  const response = await fetch(fixture.config.resource, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'search_skills', arguments: { query: 'catalog' } } }),
  signal: AbortSignal.timeout(MCP_TEST_CONFIG.requestMs) });
  assert.equal(response.status, expected);
  const text = await response.text();
  assert.doesNotMatch(text, /private|user_[ABC]|fixture\.invalid|sk_test|oat_user|ownerId|sessionId/);
  if (expected !== 503) assert.ok(response.headers.get('www-authenticate'));
}

test('real SDK HTTP initialize/list/call: all four tools isolate shared slugs, bodies, sources, tags and 53-row pagination', async () => {
  for (const user of ['user_A', 'user_B']) {
    const { client } = await fixture.connect(`oat_${user}`);
    assert.equal(client.getServerVersion().name, 'headjack');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['get_skill', 'install_command', 'list_my_skills', 'search_skills']);
    assert.ok(tools.every((t) => t.inputSchema.additionalProperties === false));
    const skill = await call(client, 'get_skill', { slug: 'A' });
    assert.equal(skill.skill_md, fixtureBody(user, 'A'));
    assert.equal(skill.source_url, fixtureSource(user));
    assert.deepEqual(skill.tags, [user]);
    const first = await call(client, 'list_my_skills');
    const second = await call(client, 'list_my_skills', { cursor: first.next_cursor });
    const expected = [...MCP_TEST_SLUGS, `only-${user}`].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.equal(first.skills.length, 50); assert.equal(second.skills.length, 3);
    assert.deepEqual([...first.skills, ...second.skills].map((s) => s.slug), expected);
    assert.equal(second.next_cursor, null);
    assert.ok([...first.skills, ...second.skills].every((s) => s.name.startsWith(user) && s.tags.includes(user) && !['skill_md', 'source_url', 'review_notes', 'scan_flags', 'sha256'].some((field) => field in s)));
    const filtered = await call(client, 'list_my_skills', { tag: 'target', kind: 'skill' });
    assert.deepEqual(filtered.skills.map((s) => s.slug), ['😀']);
    const search = await call(client, 'search_skills', { query: 'catalog', tags: [user], k: 10 });
    assert.equal(search.results.length, 10);
    assert.ok(search.results.every((s) => s.description.includes(user) && s.tags.includes(user)));
    assert.deepEqual((await call(client, 'search_skills', { query: 'catalog', tags: [user === 'user_A' ? 'user_B' : 'user_A'] })).results, []);
    assert.deepEqual(await call(client, 'install_command', { slug: 'A', harness: 'claude' }), { command: "headjack add --to 'claude' --session -- 'A'", reload_plugins: false });
  }
  assert.ok(['initialize', 'tools/list', 'tools/call'].every((m) => fixture.events.methods.includes(m)));
});

test('Bearer syntax variants initialize and call through real SDK HTTP with online grant and live admission per request', async () => {
  const token = 'oat_' + 'MiXeD9_-';
  fixture.grants.set(token, { ...fixture.grants.get('oat_user_A') });
  try {
    for (const [scheme, spaces] of [['Bearer', 1], ['bearer', 1], ['BEARER', 1], ['bEaReR', 1], ['Bearer', 2], ['bearer', 3]]) {
      const { client } = await fixture.connect(token, { scheme, spaces });
      assert.equal(client.getServerVersion().name, 'headjack');
      const { grants, users } = fixture.events;
      assert.equal((await client.listTools()).tools.length, 4);
      assert.equal((await call(client, 'get_skill', { slug: 'A' })).skill_md, fixtureBody('user_A', 'A'));
      assert.equal(fixture.events.grants - grants, 2, 'both requests verify the unchanged mixed-case token online');
      assert.equal(fixture.events.users - users, 2, 'both requests repeat live user admission');
    }
  } finally {
    fixture.grants.delete(token);
  }
});

test('malformed Bearer prefix, credential grammar and whitespace deny before provider, tools or owner writes over HTTP', async () => {
  const before = await fixture.snapshot();
  const { grants, users, repos, owners } = fixture.events;
  for (const authorization of [
    'Basic oat_user_A', 'Beareroat_user_A', 'Bearer OAT_user_A', 'bearer oaT_user_A', 'Bearer oat_',
    'Bearer\toat_user_A', 'Bearer \toat_user_A', 'Bearer\t oat_user_A',
    'Bearer oat_user_ A', 'Bearer oat_user_\tA', 'Bearer oat_user_A extra',
    'Bearer oat_user_A=', 'Bearer oat_user_A/', 'Bearer oat_user_A,',
  ]) await denied('', 401, { authorization, cookie: '__session=session; __client_uat=1' });
  assert.deepEqual({ grants: fixture.events.grants, users: fixture.events.users, repos: fixture.events.repos, owners: fixture.events.owners }, { grants, users, repos, owners });
  assert.deepEqual(await fixture.snapshot(), before);
});

test('one official client reauthenticates on every request; parallel clients retain separate RLS and Flags contexts', async () => {
  const { client, auth } = await fixture.connect();
  assert.equal((await call(client, 'get_skill', { slug: 'A' })).skill_md, fixtureBody('user_A', 'A'));
  auth.token = 'oat_' + 'user_B';
  assert.equal((await call(client, 'get_skill', { slug: 'A' })).skill_md, fixtureBody('user_B', 'A'));
  const a = await fixture.connect('oat_user_A');
  const b = await fixture.connect('oat_user_B');
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const user = i % 2 ? 'user_B' : 'user_A';
    return { user, result: await call(i % 2 ? b.client : a.client, 'get_skill', { slug: 'A' }) };
  }));
  for (const { user, result } of results) assert.equal(result.skill_md, fixtureBody(user, 'A'));
  const start = fixture.events.contexts.length;
  const searches = await Promise.all([call(a.client, 'search_skills', { query: 'catalog', tags: ['user_A'] }), call(b.client, 'search_skills', { query: 'catalog', tags: ['user_B'] })]);
  for (const [i, user] of ['user_A', 'user_B'].entries()) assert.ok(searches[i].results.length > 0 && searches[i].results.every((r) => r.tags.includes(user)));
  const contexts = fixture.events.contexts.slice(start);
  assert.deepEqual(contexts.map((c) => c.ownerId).sort(), Object.values(fixture.owners).sort());
  assert.ok(contexts.every((c) => /^[\da-f-]{36}$/.test(c.sessionId) && c.sessionId !== 'client-chosen-session'));
  assert.notEqual(contexts[0].sessionId, contexts[1].sessionId);
});

test('foreign cursor and malformed/unknown tool inputs have stable errors before repository access; foreign and missing skills are indistinguishable', async () => {
  const a = await fixture.connect(); const b = await fixture.connect('oat_user_B');
  const first = await call(a.client, 'list_my_skills');
  const repos = fixture.events.repos;
  for (const [client, name, args] of [
    [b.client, 'list_my_skills', { cursor: first.next_cursor }],
    [a.client, 'list_my_skills', { cursor: first.next_cursor, tag: 'target' }],
    [a.client, 'get_skill', { slug: 'A', ownerId: fixture.owners.user_B }],
    [a.client, 'search_skills', { query: 123 }], [a.client, 'unknown_tool', {}],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true); assert.deepEqual(content(result), { error: { code: 'invalid_input' } });
  }
  assert.equal(fixture.events.repos, repos);
  for (const name of ['get_skill', 'install_command']) {
    const args = name === 'install_command' ? { harness: 'claude' } : {};
    const foreign = await a.client.callTool({ name, arguments: { ...args, slug: 'only-user_B' } });
    const missing = await a.client.callTool({ name, arguments: { ...args, slug: 'missing' } });
    assert.equal(foreign.isError, true); assert.deepEqual(content(foreign), { error: { code: 'not_found' } });
    assert.deepEqual(foreign, missing);
  }
});

test('simulated-provider forged/expired/wrong-scope/resource and session/key/legacy credentials are rejected before tools or owner writes', async () => {
  const original = fixture.grants.get('oat_user_C');
  const before = await fixture.snapshot(); const repos = fixture.events.repos; const owners = fixture.events.owners;
  for (const change of [{ expired: true }, { revoked: true }, { scopes: ['skills:write'] }, { aud: ['https://foreign.invalid/mcp'] }, { aud: undefined }]) {
    fixture.grants.set('oat_user_C', { ...original, ...change });
    await denied('oat_user_C', change.scopes ? 403 : 401);
  }
  fixture.grants.set('oat_user_C', original);
  const provider = fixture.events.grants;
  for (const token of ['eyJhbGciOiJSUzI1NiJ9.session.signature', 'ak_fixture', 'sk_fixture', 'm2m_fixture', 'legacy-token']) await denied(token);
  await denied('legacy-token', 401, { cookie: '__session=session; __client_uat=1' });
  assert.equal(fixture.events.grants, provider, 'non-OAuth credentials never reach grant verification');
  await denied('oat_forged');
  assert.equal(fixture.events.repos, repos); assert.equal(fixture.events.owners, owners);
  assert.deepEqual(await fixture.snapshot(), before);
});

test('simulated-provider ban, lock, deletion and revocation after a successful request deny the reused client on its next request', async () => {
  const { client } = await fixture.connect();
  const grant = fixture.grants.get('oat_user_A'); const user = fixture.users.get('user_A');
  for (const transition of ['ban', 'lock', 'delete', 'revoke']) {
    await call(client, 'get_skill', { slug: 'A' });
    const before = await fixture.snapshot(); const repos = fixture.events.repos; const owners = fixture.events.owners;
    if (transition === 'ban') user.banned = true;
    if (transition === 'lock') user.locked = true;
    if (transition === 'delete') fixture.users.delete('user_A');
    if (transition === 'revoke') grant.revoked = true;
    try {
      await assert.rejects(client.callTool({ name: 'search_skills', arguments: { query: 'catalog' } }), (error) => error.data?.status === 401);
      assert.equal(fixture.events.repos, repos); assert.equal(fixture.events.owners, owners);
      assert.deepEqual(await fixture.snapshot(), before);
    } finally {
      user.banned = false; user.locked = false; fixture.users.set('user_A', user); grant.revoked = false;
    }
  }
});

test('unset owner and pool reuse after SQL/provider/tool errors cannot expose another owner', async () => {
  const a = await fixture.connect(); const b = await fixture.connect('oat_user_B');
  const anonymous = createRepo(fixture.pool);
  assert.equal((await fixture.pool.query('select current_user as role')).rows[0].role, 'headjack_app');
  await assert.rejects(fixture.db.withOwner(fixture.owners.user_A, async (tx) => {
    await tx.query("insert into skills(slug,name,description,kind) values ('rollback-marker','Rollback','Must roll back','skill')");
    await tx.query('select missing_fixture_column from skills');
  }), { code: '42703' });
  assert.deepEqual(await call(a.client, 'get_skill', { slug: 'rollback-marker' }), { error: { code: 'not_found' } });
  assert.deepEqual(await anonymous.listMcpSkills(), []); assert.equal(await anonymous.getMcpSkill('A'), null);
  await assert.rejects(anonymous.consumeMcpSearchBudget(), { code: '22023' });
  fixture.state.embedFailure = true;
  assert.deepEqual(await call(a.client, 'search_skills', { query: 'catalog' }), { error: { code: 'service_unavailable' } });
  fixture.state.embedFailure = false;
  fixture.state.providerFailure = true;
  await denied('oat_user_C', 503);
  fixture.state.providerFailure = false;
  assert.equal((await call(b.client, 'get_skill', { slug: 'A' })).skill_md, fixtureBody('user_B', 'A'));
  assert.equal((await call(a.client, 'get_skill', { slug: 'A' })).skill_md, fixtureBody('user_A', 'A'));
  assert.deepEqual(await anonymous.listMcpSkills(), []);
});

test('HTTP search quotas share the durable owner budget across reauth clients and isolate other owners (PGlite serializes connections)', async () => {
  const a = await fixture.connect(); const another = await fixture.connect(); const b = await fixture.connect('oat_user_B');
  let stable = false;
  // DB-clock boundary retries use a new owner, never retry a failed quota assertion.
  for (let attempt = 0; attempt < MCP_TEST_CONFIG.quotaAttempts; attempt++) {
    const id = `user_Quota${attempt}`;
    fixture.users.set(id, { ...fixture.users.get('user_A'), id });
    fixture.grants.set(`oat_${id}`, { ...fixture.grants.get('oat_user_A'), subject: id });
    a.auth.token = 'oat_' + id; another.auth.token = 'oat_' + id;
    const minute = async () => (await fixture.pg.query("select date_trunc('minute', clock_timestamp())::text as minute")).rows[0].minute;
    const before = await minute(); const embeds = fixture.events.embeds; const flagsStart = fixture.events.contexts.length;
    const responses = [];
    for (let i = 0; i < 61; i++) responses.push(await call(i % 2 ? a.client : another.client, 'search_skills', { query: 'catalog' }));
    if (before !== await minute()) continue;
    assert.ok(responses.slice(0, 60).every((r) => Array.isArray(r.results)));
    assert.equal(responses[60].error.code, 'rate_limited');
    assert.ok(Number.isInteger(responses[60].error.retry_after) && responses[60].error.retry_after >= 1 && responses[60].error.retry_after <= 60);
    assert.equal(fixture.events.embeds - embeds, 60);
    const contexts = fixture.events.contexts.slice(flagsStart);
    assert.equal(contexts.length, 60);
    assert.equal(new Set(contexts.map((c) => c.ownerId)).size, 1);
    assert.equal(new Set(contexts.map((c) => c.sessionId)).size, 60);
    const { rows } = await fixture.pg.query('select used from app.mcp_search_budget where owner_id=(select id from owners where ref_id=$1)', [`clerk:${id}`]);
    assert.deepEqual(rows, [{ used: 61 }]);
    const own = await call(b.client, 'search_skills', { query: 'catalog', tags: ['user_B'] });
    assert.ok(own.results.length > 0 && own.results.every((r) => r.tags.includes('user_B')));
    stable = true; break;
  }
  assert.ok(stable, 'quota fixture crossed a DB minute in every bounded fresh-owner attempt');
});
