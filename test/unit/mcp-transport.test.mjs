import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpTools } from '../../lib/mcp/tools.mjs';
import { ForbiddenError } from '../../lib/errors.mjs';

const config = { resource: 'https://vault.example/mcp', issuer: 'https://auth.example', allowedOrigins: ['https://client.example'], cursorSecret: 'test-' + 'secret-longer-than-thirty-two-bytes' };
const request = (headers = {}, method = 'POST') => new Request(config.resource, { method, headers });
async function setup(overrides = {}) {
  const { createMcpHttp } = await import('../../lib/mcp/transport.mjs');
  const events = [];
  const tools = createMcpTools({ repoFor: () => ({ listMcpSkills: async () => [] }), cursorSecret: config.cursorSecret });
  const http = createMcpHttp({
    enabled: async () => { events.push('flag'); return true; },
    getMetadataConfig: () => { events.push('config'); return config; },
    getDependencies: async () => { events.push('dependencies'); return { config, tools, identify: async () => { events.push('identify'); return { ownerId: 7, subject: { refId: 'clerk:user_fixture' } }; } }; },
    ...overrides,
  });
  return { http, events, tools };
}

test('flag-off every HTTP surface is 404 with missing secrets and zero dependency/config/provider I/O', async () => {
  const { http, events } = await setup({ enabled: async () => false, getDependencies: () => { throw new Error('missing secrets'); }, getMetadataConfig: () => { throw new Error('missing secrets'); } });
  for (const name of ['post', 'metadata', 'options', 'unsupported']) {
    assert.equal((await http[name](request())).status, 404);
  }
  assert.deepEqual(events, []);
});

for (const origin of ['https://hostile.example', 'null', 'https://client.example.evil', 'https://client.example/']) {
  test(`reject Origin ${origin} before dependencies/identity`, async () => {
    const { http, events } = await setup();
    assert.equal((await http.post(request({ origin }))).status, 403);
    assert.deepEqual(events, ['flag', 'config']);
  });
}

test('401 advertises configured metadata despite hostile Host and forwarding headers', async () => {
  const { http } = await setup({ getDependencies: async () => ({ config, identify: async () => null }) });
  const response = await http.post(request({ host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example;proto=http' }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /resource_metadata="https:\/\/vault.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.doesNotMatch(response.headers.get('www-authenticate'), /evil/);
});

test('insufficient scope is 403 with OAuth scope challenge', async () => {
  const { http } = await setup({ getDependencies: async () => ({ config, identify: async () => { throw new ForbiddenError('private details'); } }) });
  const response = await http.post(request());
  assert.equal(response.status, 403);
  assert.match(response.headers.get('www-authenticate'), /insufficient_scope/);
  assert.match(response.headers.get('www-authenticate'), /skills:read/);
  assert.doesNotMatch(await response.text(), /private details/);
});

test('provider and dependency outage is sanitized 503 without logging secrets', async () => {
  for (const getDependencies of [async () => { throw new Error('secret private database'); }, async () => ({ config, identify: async () => { throw new Error('secret private provider'); } })]) {
    const { http } = await setup({ getDependencies });
    const response = await http.post(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'service_unavailable' } });
  }
});

test('public metadata and OPTIONS expose trusted resource and scopes, wildcard CORS without credentials or dependencies', async () => {
  const { http, events } = await setup({ getDependencies: () => { throw new Error('DB must stay closed'); } });
  const response = await http.metadata(request({ origin: 'https://any.example', host: 'evil.example' }, 'GET'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ['skills:read'] });
  const preflight = await http.options(request({ origin: 'null' }, 'OPTIONS'));
  assert.equal(preflight.status, 200);
  for (const res of [response, preflight]) {
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  assert.deepEqual(events, ['flag', 'config', 'flag']);
});

test('unsupported methods are 405 without provider/DB initialization', async () => {
  const { http, events } = await setup();
  const response = await http.unsupported(request({}, 'DELETE'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  assert.deepEqual(events, ['flag']);
});

test('gate is evaluated on each request and exceptions fail closed', async () => {
  let enabled = true;
  const { http } = await setup({ enabled: async () => { if (enabled === null) throw new Error('private flag error'); return enabled; } });
  assert.equal((await http.metadata(request({}, 'GET'))).status, 200);
  enabled = false;
  assert.equal((await http.metadata(request({}, 'GET'))).status, 404);
  enabled = null;
  assert.equal((await http.post(request())).status, 404);
});

test('MCP browser preflight allows POST and authorization; metadata preflight remains public GET', async () => {
  const { http } = await setup();
  const transport = await http.options(request({ origin: 'https://client.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' }, 'OPTIONS'));
  assert.equal(transport.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(transport.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, MCP-Protocol-Version');
  const metadata = await http.options(new Request('https://vault.example/.well-known/oauth-protected-resource/mcp', { method: 'OPTIONS' }));
  assert.equal(metadata.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});

test('allowed browser Origin can read OAuth challenge and provider outage without cookies', async () => {
  for (const identify of [async () => null, async () => { throw new Error('private provider error'); }]) {
    const { http } = await setup({ getDependencies: async () => ({ config, identify }) });
    const response = await http.post(request({ origin: 'https://client.example' }));
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://client.example');
    assert.equal(response.headers.get('access-control-expose-headers'), 'WWW-Authenticate');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('MCP serverInfo name is headjack', async () => {
  const { http } = await setup();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: ['2025-03-26'] });
  const transport = new StreamableHTTPClientTransport(new URL(config.resource), {
    requestInit: { headers: { authorization: 'Bearer oat_fixture' } },
    fetch: async (url, init) => {
      const req = new Request(url, init);
      return req.method === 'POST' ? http.post(req) : http.unsupported(req);
    },
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'headjack');
  } finally { await client.close(); }
});

for (const origin of [undefined, 'https://client.example']) {
  test(`SDK initialize/list/call protocol with ${origin ?? 'native absent Origin'} and strict schemas`, async () => {
    const contexts = [];
    const { http, tools } = await setup();
    const originalCall = tools.call;
    tools.call = async (name, input, context) => { contexts.push(context); return originalCall(name, input, context); };
    const methods = [];
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: ['2025-03-26'] });
    const transport = new StreamableHTTPClientTransport(new URL(config.resource), {
      requestInit: { headers: { authorization: 'Bearer oat_fixture', ...(origin ? { origin } : {}) } },
      fetch: async (url, init) => {
        const req = new Request(url, init);
        if (req.method === 'POST') {
          methods.push((await req.clone().json()).method);
          const response = await http.post(req);
          assert.equal(response.headers.get('mcp-session-id'), null);
          assert.equal(response.headers.get('set-cookie'), null);
          return response;
        }
        return http.unsupported(req);
      },
    });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().name, 'headjack');
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 4);
      assert.ok(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false));
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool({ name: 'list_my_skills', arguments: {} });
        assert.deepEqual(result.structuredContent, { skills: [], next_cursor: null });
      }
      const invalid = await client.callTool({ name: 'list_my_skills', arguments: { ownerId: 900 } });
      assert.equal(invalid.isError, true);
      assert.deepEqual(invalid.structuredContent, { error: { code: 'invalid_input' } });
      assert.deepEqual(invalid.content, [{ type: 'text', text: JSON.stringify(invalid.structuredContent) }]);
      const unknown = await client.callTool({ name: 'unknown_tool', arguments: {} });
      assert.equal(unknown.isError, true);
      assert.deepEqual(unknown.structuredContent, { error: { code: 'invalid_input' } });
      assert.deepEqual(unknown.content, [{ type: 'text', text: JSON.stringify(unknown.structuredContent) }]);
      const malformed = await client.callTool({ name: 'search_skills', arguments: { query: 123 } });
      assert.equal(malformed.isError, true);
      assert.deepEqual(malformed.structuredContent, { error: { code: 'invalid_input' } });
      assert.deepEqual(malformed.content, [{ type: 'text', text: JSON.stringify(malformed.structuredContent) }]);
      assert.equal(contexts.length, 5);
      assert.ok(contexts.every((ctx) => ctx.ownerId === 7 && /^[\da-f-]{36}$/.test(ctx.sessionId)));
      assert.notEqual(contexts[0].sessionId, contexts[1].sessionId);
      assert.ok(methods.includes('initialize'));
      assert.ok(methods.includes('tools/list'));
      assert.ok(methods.includes('tools/call'));
    } finally { await client.close(); }
  });
}

// Next 16 route handlers (dynamic 'auto') receive the request wrapped in a Proxy that reads every
// property on the target and binds methods to it (next/dist/server/route-modules/app-route/module.js
// proxyNextRequest + ReflectAdapter). Reads work, but Node 24's `new Request(input)` reads a
// Request input's private #state directly, which the Proxy does not have.
const nextRouteRequest = (req) => new Proxy(req, { get(target, prop) {
  const value = Reflect.get(target, prop, target);
  return typeof value === 'function' ? value.bind(target) : value;
} });

test('Next route-handler request proxy still serves initialize/list/call (preview 500 regression)', async () => {
  const { http } = await setup();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { supportedProtocolVersions: ['2025-03-26'] });
  const transport = new StreamableHTTPClientTransport(new URL(config.resource), {
    requestInit: { headers: { authorization: 'Bearer oat_fixture' } },
    fetch: async (url, init) => {
      const req = nextRouteRequest(new Request(url, init));
      return req.method === 'POST' ? http.post(req) : http.unsupported(req);
    },
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'headjack');
    assert.equal((await client.listTools()).tools.length, 4);
    const result = await client.callTool({ name: 'list_my_skills', arguments: {} });
    assert.deepEqual(result.structuredContent, { skills: [], next_cursor: null });
  } finally { await client.close(); }
});

test('concurrent requests carry distinct verified owners through SDK auth context', async () => {
  const { tools } = await setup();
  const contexts = [];
  tools.call = async (name, input, context) => {
    await new Promise((resolve) => setImmediate(resolve));
    contexts.push(context);
    return { content: [{ type: 'text', text: '{}' }], structuredContent: { ownerId: context.ownerId } };
  };
  const { http } = await setup({ getDependencies: async () => ({ config, tools, identify: async (req) => ({ ownerId: req.headers.get('authorization') === 'Bearer oat_a' ? 7 : 8 }) }) });
  const results = await Promise.all(['a', 'b'].map(async (id) => {
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(config.resource), { requestInit: { headers: { authorization: `Bearer oat_${id}` } }, fetch: (url, init) => http.post(new Request(url, init)) });
    try { await client.connect(transport); return await client.callTool({ name: 'list_my_skills', arguments: {} }); }
    finally { await client.close(); }
  }));
  assert.deepEqual(results.map((result) => result.structuredContent.ownerId), [7, 8]);
  assert.deepEqual(contexts.map((ctx) => ctx.ownerId).sort(), [7, 8]);
  assert.notEqual(contexts[0].sessionId, contexts[1].sessionId);
});
