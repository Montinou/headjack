import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { createMcpServer, mapError, serveStdio, timeoutMs, withTimeout } from '../../cli/mcp.mjs';
import { validate } from '../../cli/mcp-schema.mjs';
import { ApiError, createApi } from '../../cli/api.mjs';
import { UserError } from '../../lib/errors.mjs';

const CANARY = 'canaryword';
const PATH_CANARY = '/private/area/canaryword/state';
const MAX_LINE = 1048576;

const ECHO_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', minLength: 1, maxLength: 10 }, n: { type: 'integer', minimum: 1, maximum: 5 } },
  required: ['text'],
  additionalProperties: false,
};

// A fake api: counts opens and closes; `open` decides each outcome.
function harness({ tools, open, mode = 'hosted' } = {}) {
  const state = { opened: 0, closed: 0 };
  const defaultOpen = async () => ({ api: { name: 'fake' }, close: () => {} });
  const openApi = async () => {
    state.opened += 1;
    const handle = await (open ?? defaultOpen)(state.opened);
    return { api: handle.api, close: () => { state.closed += 1; return handle.close?.(); } };
  };
  const list = tools ?? [{
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: ECHO_SCHEMA,
    handler: async (args, { api }) => ({ text: args.text, api: api.name }),
  }];
  const server = createMcpServer({ tools: list, openApi, version: '9.9.9', mode });
  const send = async (message) => {
    const out = await server.handleLine(typeof message === 'string' ? message : JSON.stringify(message));
    return out === null ? null : JSON.parse(out);
  };
  return { server, state, send };
}

const call = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const payload = (res) => JSON.parse(res.result.content[0].text);

// ---- validate ----

test('validate: types, bounds, enum, required and additionalProperties', () => {
  const schema = {
    type: 'object',
    properties: {
      s: { type: 'string', minLength: 2, maxLength: 4 },
      i: { type: 'integer', minimum: 1, maximum: 3 },
      e: { type: 'string', enum: ['a', 'b'] },
      a: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', maxLength: 2 } },
    },
    required: ['s'],
    additionalProperties: false,
  };
  assert.deepEqual(validate(schema, { s: 'ab' }), { ok: true });
  assert.deepEqual(validate(schema, { s: 'abcd', i: 3, e: 'b', a: ['x', 'yy'] }), { ok: true });
  const bad = [
    {}, { s: 'a' }, { s: 'abcde' }, { s: 1 }, { s: 'ab', i: 0 }, { s: 'ab', i: 4 }, { s: 'ab', i: 1.5 }, { s: 'ab', i: '2' },
    { s: 'ab', e: 'c' }, { s: 'ab', a: [] }, { s: 'ab', a: ['x', 'y', 'z'] }, { s: 'ab', a: ['xyz'] }, { s: 'ab', a: 'x' },
    { s: 'ab', extra: 1 }, null, [], 'text', 3,
  ];
  for (const value of bad) {
    const result = validate(schema, value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(typeof result.reason, 'string');
  }
});

test('validate: a schema keyword or type outside the subset fails closed, and values are not echoed', () => {
  assert.equal(validate({ type: 'boolean' }, true).ok, false);
  const result = validate({ type: 'object', properties: { s: { type: 'string', maxLength: 3 } } }, { s: CANARY });
  assert.equal(result.ok, false);
  assert.ok(!result.reason.includes(CANARY));
});

test('validate: a __proto__ key in the input is an unknown property', () => {
  const value = JSON.parse('{"text":"a","__proto__":{"x":1}}');
  assert.equal(validate(ECHO_SCHEMA, value).ok, false);
});

// ---- protocol ----

test('initialize answers the client protocol version when known, else 2025-06-18, and never opens the api', async () => {
  const { send, state } = harness({ mode: 'local' });
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18']) {
    const res = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } });
    assert.equal(res.result.protocolVersion, version);
  }
  for (const params of [{ protocolVersion: '1999-01-01' }, {}, undefined, { protocolVersion: 5 }]) {
    const res = await send({ jsonrpc: '2.0', id: 2, method: 'initialize', params });
    assert.equal(res.result.protocolVersion, '2025-06-18');
  }
  const res = await send({ jsonrpc: '2.0', id: 'x', method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(res.id, 'x');
  assert.equal(res.jsonrpc, '2.0');
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.deepEqual(res.result.serverInfo, { name: 'headjack', version: '9.9.9' });
  assert.match(res.result.instructions, /local/);
  assert.match(res.result.instructions, /untrusted/);
  assert.equal(state.opened, 0);
});

test('instructions name the hosted mode', async () => {
  const { send } = harness({ mode: 'hosted' });
  const res = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.match(res.result.instructions, /hosted/);
});

test('instructions name the hosted server origin, without credentials, path or query', async () => {
  const hosted = async (origin) => {
    const server = createMcpServer({ tools: [], openApi: async () => ({ api: {}, close() {} }), version: '1.0.0', mode: 'hosted', origin });
    return JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))).result.instructions;
  };
  const named = await hosted('https://user:pw@vault.example.invalid:8443/base/path?token=abc#frag');
  assert.match(named, /hosted mode/);
  assert.ok(named.includes('https://vault.example.invalid:8443'), named);
  assert.doesNotMatch(named, /user|pw@|base|path|token|abc|frag/);
  assert.match(named, /untrusted/);
  assert.ok((await hosted('http://localhost:3000')).includes('http://localhost:3000'));
  const generic = await hosted(undefined);
  assert.match(generic, /hosted mode/);
  assert.doesNotMatch(generic, /https?:/);
  // Anything that is not an http(s) URL gives the generic text: the first tool call reports the problem.
  for (const bad of ['', 'not a url', 'ftp://host.example.invalid', 'file:///etc/hosts', 'javascript:alert(1)', 'https://', null, 7, {}, ['https://a.example.invalid']]) {
    assert.equal(await hosted(bad), generic, String(bad));
  }
});

test('the origin never reaches the instructions of the local mode', async () => {
  const server = createMcpServer({ tools: [], openApi: async () => ({ api: {}, close() {} }), version: '1.0.0', mode: 'local', origin: 'https://vault.example.invalid' });
  const { instructions } = JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))).result;
  assert.match(instructions, /local/);
  assert.doesNotMatch(instructions, /vault\.example/);
});

test('ping answers an empty result; tools/list lists name, description and inputSchema only', async () => {
  const { send, state } = harness();
  assert.deepEqual(await send({ jsonrpc: '2.0', id: 3, method: 'ping' }), { jsonrpc: '2.0', id: 3, result: {} });
  const res = await send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.deepEqual(res.result, { tools: [{ name: 'echo', description: 'Echo the text back.', inputSchema: ECHO_SCHEMA }] });
  assert.equal(state.opened, 0);
});

test('notifications produce no output, and an unknown request is -32601', async () => {
  const { server, send } = harness();
  assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })), null);
  assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'whatever/unknown' })), null);
  const res = await send({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.deepEqual(res, { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'method not found' } });
});

test('malformed JSON is -32700 with a null id', async () => {
  const { send } = harness();
  assert.deepEqual(await send('{"jsonrpc":'), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
});

test('an array, a non-object and a missing method are -32600', async () => {
  const { send } = harness();
  for (const line of ['[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', '5', '"text"', 'null', 'true']) {
    const res = await send(line);
    assert.deepEqual(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, line);
  }
  const noMethod = await send({ jsonrpc: '2.0', id: 9 });
  assert.deepEqual(noMethod, { jsonrpc: '2.0', id: 9, error: { code: -32600, message: 'invalid request' } });
  const badMethod = await send({ jsonrpc: '2.0', id: 10, method: 5 });
  assert.equal(badMethod.error.code, -32600);
  const badId = await send({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' });
  assert.deepEqual(badId, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
});

test('a line over 1 MiB is -32600', async () => {
  const { send } = harness();
  const res = await send(' '.repeat(MAX_LINE + 1));
  assert.deepEqual(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
});

// ---- tools/call ----

test('a successful call returns the result shape and opens then closes the api', async () => {
  const { send, state } = harness();
  const res = await send(call('echo', { text: 'hi' }));
  assert.equal(res.result.isError, false);
  assert.equal(res.result.content.length, 1);
  assert.equal(res.result.content[0].type, 'text');
  assert.deepEqual(payload(res), { text: 'hi', api: 'fake' });
  assert.deepEqual(state, { opened: 1, closed: 1 });
});

test('a call without arguments validates the empty object', async () => {
  const { send } = harness();
  const res = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
  assert.deepEqual(payload(res), { error: { code: 'invalid_input' } });
});

test('invalid input, an unknown tool and malformed params are isError invalid_input and never open the api', async () => {
  const { send, state } = harness();
  const cases = [
    call('echo', { text: '' }),
    call('echo', { text: 'ok', n: 9 }),
    call('echo', { text: 'ok', extra: true }),
    call('echo', 'text'),
    call('missing', { text: 'ok' }),
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 5 } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'echo' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call' },
  ];
  for (const message of cases) {
    const res = await send(message);
    assert.equal(res.error, undefined, JSON.stringify(message));
    assert.equal(res.result.isError, true);
    assert.deepEqual(payload(res), { error: { code: 'invalid_input' } });
  }
  assert.equal(state.opened, 0);
});

test('openApi rejecting with a UserError is unauthenticated (hosted) or unavailable (local); no message leaks', async () => {
  const open = async () => { throw new UserError(`not logged in at ${PATH_CANARY}: ${CANARY}`); };
  for (const [mode, code] of [['hosted', 'unauthenticated'], ['local', 'unavailable']]) {
    const { server } = harness({ open, mode });
    const out = await server.handleLine(JSON.stringify(call('echo', { text: 'hi' })));
    assert.deepEqual(payload(JSON.parse(out)), { error: { code } });
    assert.ok(!out.includes(CANARY));
    assert.ok(!out.includes('private'));
  }
});

test('an unrecognized error is internal and its message is not copied', async () => {
  const { server } = harness({ open: async () => { throw new TypeError(`boom ${CANARY}`); } });
  const out = await server.handleLine(JSON.stringify(call('echo', { text: 'hi' })));
  assert.deepEqual(payload(JSON.parse(out)), { error: { code: 'internal' } });
  assert.ok(!out.includes(CANARY));
});

test('every api status maps to its fixed code, through a handler', async () => {
  const table = [
    [400, 'bad_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'],
    [429, 'rate_limited'], [500, 'unavailable'], [502, 'unavailable'], [503, 'unavailable'], [0, 'unavailable'],
    [418, 'internal'],
  ];
  for (const [status, code] of table) {
    const tools = [{
      name: 'fail', description: 'x', inputSchema: { type: 'object', additionalProperties: false },
      handler: async () => { throw new ApiError(status, 'server_code', `message ${CANARY}`); },
    }];
    const { server, state } = harness({ tools });
    const out = await server.handleLine(JSON.stringify(call('fail', {})));
    const res = JSON.parse(out);
    assert.equal(res.result.isError, true);
    assert.deepEqual(payload(res), { error: { code } }, String(status));
    assert.ok(!out.includes(CANARY));
    assert.equal(state.closed, 1);
  }
});

test('mapError: damaged and busy vaults, coded errors, UserError by mode, anything else', () => {
  assert.equal(mapError(new ApiError(422, 'vault_damaged', PATH_CANARY), { mode: 'local' }), 'vault_damaged');
  assert.equal(mapError(new ApiError(503, 'unavailable', 'vault is busy'), { mode: 'local' }), 'unavailable');
  for (const code of ['content_unavailable', 'unsupported_harness', 'invalid_input']) {
    assert.equal(mapError(Object.assign(new Error('x'), { code }), { mode: 'hosted' }), code);
  }
  assert.equal(mapError(Object.assign(new Error('x'), { code: 'EACCES' }), { mode: 'hosted' }), 'internal');
  assert.equal(mapError(new UserError('x'), { mode: 'hosted' }), 'unauthenticated');
  assert.equal(mapError(new UserError('x'), { mode: 'local' }), 'unavailable');
  assert.equal(mapError(new Error('x'), { mode: 'hosted' }), 'internal');
  assert.equal(mapError('text', { mode: 'hosted' }), 'internal');
  assert.equal(mapError(null, { mode: 'hosted' }), 'internal');
  assert.equal(mapError(undefined, { mode: 'local' }), 'internal');
});

test('a coded error thrown by a handler passes through', async () => {
  for (const code of ['content_unavailable', 'unsupported_harness', 'invalid_input']) {
    const tools = [{
      name: 'fail', description: 'x', inputSchema: { type: 'object', additionalProperties: false },
      handler: async () => { throw Object.assign(new Error(CANARY), { code }); },
    }];
    const { server } = harness({ tools });
    const out = await server.handleLine(JSON.stringify(call('fail', {})));
    assert.deepEqual(payload(JSON.parse(out)), { error: { code } });
    assert.ok(!out.includes(CANARY));
  }
});

test('openApi is called again after a failure, and the second call can succeed', async () => {
  const { send, state } = harness({
    open: async (attempt) => {
      if (attempt === 1) throw new UserError('not logged in');
      return { api: { name: 'second' } };
    },
  });
  const first = await send(call('echo', { text: 'hi' }));
  assert.deepEqual(payload(first), { error: { code: 'unauthenticated' } });
  const second = await send(call('echo', { text: 'hi' }));
  assert.equal(second.result.isError, false);
  assert.deepEqual(payload(second), { text: 'hi', api: 'second' });
  const third = await send(call('echo', { text: 'hi' }));
  assert.deepEqual(payload(third), { text: 'hi', api: 'second' });
  assert.equal(state.opened, 3);
});

test('close runs after success and after a handler failure, and a throwing close is ignored', async () => {
  const tools = [
    { name: 'ok', description: 'x', inputSchema: { type: 'object', additionalProperties: false }, handler: async () => ({ fine: true }) },
    { name: 'bad', description: 'x', inputSchema: { type: 'object', additionalProperties: false }, handler: async () => { throw new Error('no'); } },
  ];
  const { send, state } = harness({ tools, open: async () => ({ api: {}, close: () => { throw new Error(`close ${CANARY}`); } }) });
  const ok = await send(call('ok', {}));
  assert.deepEqual(payload(ok), { fine: true });
  assert.equal(state.closed, 1);
  const bad = await send(call('bad', {}));
  assert.deepEqual(payload(bad), { error: { code: 'internal' } });
  assert.equal(state.closed, 2);
});

test('a result that cannot be serialized is internal', async () => {
  const circular = {};
  circular.self = circular;
  const tools = [{ name: 'loop', description: 'x', inputSchema: { type: 'object', additionalProperties: false }, handler: async () => circular }];
  const { send, state } = harness({ tools });
  assert.deepEqual(payload(await send(call('loop', {}))), { error: { code: 'internal' } });
  assert.equal(state.closed, 1);
});

// ---- serveStdio ----

function streams(chunks, { endDelay } = {}) {
  const stdin = new PassThrough();
  const written = [];
  const stdout = { write(text, cb) { written.push(text); setImmediate(() => cb?.()); return true; } };
  const errs = [];
  const stderr = { write(text, cb) { errs.push(text); cb?.(); return true; } };
  const feed = async () => {
    for (const chunk of chunks) stdin.write(chunk);
    if (endDelay) await new Promise((r) => setTimeout(r, endDelay));
    stdin.end();
  };
  return { stdin, stdout, stderr, written, errs, feed };
}

const parseLines = (written) => written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('serveStdio answers initialize before any api is opened, one JSON-RPC 2.0 message per line', async () => {
  const { server, state } = harness();
  const io = streams([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    '\n',
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\r\n`,
  ]);
  io.feed();
  await serveStdio(server, io);
  const lines = parseLines(io.written);
  assert.deepEqual(lines.map((l) => l.id), [1, 2]);
  for (const line of lines) assert.equal(line.jsonrpc, '2.0');
  assert.equal(state.opened, 0);
  assert.ok(io.written.every((text) => text.endsWith('\n') && text.indexOf('\n') === text.length - 1), 'one message per write');
  assert.deepEqual(io.errs, []);
});

test('serveStdio reassembles a request split across chunks and a multi-byte character split across chunks', async () => {
  const { server } = harness();
  const line = Buffer.from(`${JSON.stringify(call('echo', { text: 'é☃' }))}\n`);
  const cut = line.indexOf(0xc3) + 1;
  const io = streams([line.subarray(0, 10), line.subarray(10, cut), line.subarray(cut)]);
  io.feed();
  await serveStdio(server, io);
  const [res] = parseLines(io.written);
  assert.deepEqual(payload(res), { text: 'é☃', api: 'fake' });
});

test('serveStdio rejects a line over 1 MiB with -32600, keeps going, and a line of exactly 1 MiB is parsed', async () => {
  const { server } = harness();
  const huge = 'x'.repeat(MAX_LINE + 1);
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' });
  const exact = ' '.repeat(MAX_LINE - ping.length) + ping;
  assert.equal(Buffer.byteLength(exact), MAX_LINE);
  const io = streams([
    huge.slice(0, 700000), huge.slice(700000), '\n',
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
    `${exact}\n`,
  ]);
  io.feed();
  await serveStdio(server, io);
  const lines = parseLines(io.written);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
  assert.deepEqual(lines[1], { jsonrpc: '2.0', id: 2, result: {} });
  assert.deepEqual(lines[2], { jsonrpc: '2.0', id: 5, result: {} });
});

test('serveStdio does not assemble a line over 1 MiB: bytes are dropped as they stream', async () => {
  const { server } = harness();
  const io = streams([]);
  const original = Buffer.concat;
  let largest = 0;
  Buffer.concat = function concat(list, total) {
    const result = original.call(this, list, total);
    largest = Math.max(largest, result.length);
    return result;
  };
  try {
    const piece = Buffer.alloc(256 * 1024, 0x78);
    for (let i = 0; i < 12; i += 1) io.stdin.write(piece);
    io.stdin.write(`\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    io.stdin.end();
    await serveStdio(server, io);
  } finally {
    Buffer.concat = original;
  }
  assert.ok(largest <= MAX_LINE + 1, `the largest assembled buffer was ${largest} bytes`);
  const lines = parseLines(io.written);
  assert.equal(lines[0].error.code, -32600);
  assert.deepEqual(lines[1], { jsonrpc: '2.0', id: 1, result: {} });
});

test('serveStdio serves requests in arrival order even when an earlier one is slower', async () => {
  const tools = [{
    name: 'slow', description: 'x', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, additionalProperties: false },
    handler: async ({ ms }) => { await new Promise((r) => setTimeout(r, ms)); return { ms }; },
  }];
  const { server } = harness({ tools });
  const io = streams([
    `${JSON.stringify(call('slow', { ms: 60 }, 1))}\n${JSON.stringify(call('slow', { ms: 1 }, 2))}\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`,
  ]);
  io.feed();
  await serveStdio(server, io);
  assert.deepEqual(parseLines(io.written).map((l) => l.id), [1, 2, 3]);
});

test('serveStdio: stdin closing during a slow tool call still flushes its response', async () => {
  const tools = [{
    name: 'slow', description: 'x', inputSchema: { type: 'object', additionalProperties: false },
    handler: async () => { await new Promise((r) => setTimeout(r, 80)); return { done: true }; },
  }];
  const { server, state } = harness({ tools });
  const io = streams([`${JSON.stringify(call('slow', {}, 1))}\n`]);
  io.feed();
  await serveStdio(server, io);
  const [res] = parseLines(io.written);
  assert.deepEqual(payload(res), { done: true });
  assert.equal(state.closed, 1);
});

test('serveStdio serves a final request that has no trailing newline', async () => {
  const { server } = harness();
  const io = streams([JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })]);
  io.feed();
  await serveStdio(server, io);
  assert.deepEqual(parseLines(io.written), [{ jsonrpc: '2.0', id: 4, result: {} }]);
});

test('serveStdio answers malformed lines and keeps serving', async () => {
  const { server } = harness();
  const io = streams(['not json\n', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`]);
  io.feed();
  await serveStdio(server, io);
  const lines = parseLines(io.written);
  assert.equal(lines[0].error.code, -32700);
  assert.deepEqual(lines[1], { jsonrpc: '2.0', id: 1, result: {} });
});

test('serveStdio: a server that throws costs one fixed internal error and one fixed stderr line, never a message', async () => {
  const server = { handleLine: async (line) => { if (line.includes('boom')) throw new Error(`secret ${CANARY} ${PATH_CANARY}`); return null; } };
  const io = streams(['boom\n']);
  io.feed();
  await serveStdio(server, io);
  const text = io.written.join('');
  assert.ok(!text.includes(CANARY));
  assert.equal(parseLines(io.written)[0].error.code, -32603);
  assert.equal(io.errs.length, 1);
  assert.ok(!io.errs[0].includes(CANARY));
  assert.ok(!io.errs[0].includes('private'));
  assert.equal(io.errs[0].endsWith('\n'), true);
  assert.equal(io.errs[0].trimEnd().includes('\n'), false);
});

test('serveStdio stops quietly when stdout fails', async () => {
  const { server } = harness();
  let writes = 0;
  const stdout = { write(text, cb) { writes += 1; setImmediate(() => cb(new Error(`EPIPE ${CANARY}`))); return false; } };
  const errs = [];
  const stderr = { write(text) { errs.push(text); return true; } };
  const stdin = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
  ]);
  await serveStdio(server, { stdin, stdout, stderr });
  assert.equal(writes, 1);
  assert.ok(errs.every((text) => !text.includes(CANARY)));
});

// ---- timeout ----

test('timeoutMs reads HEADJACK_MCP_TIMEOUT_MS when it is a positive integer, else 30000', () => {
  assert.equal(timeoutMs({}), 30000);
  assert.equal(timeoutMs({ HEADJACK_MCP_TIMEOUT_MS: '250' }), 250);
  for (const bad of ['0', '-5', '1.5', 'abc', '', ' 7', '7ms', '1e3']) {
    assert.equal(timeoutMs({ HEADJACK_MCP_TIMEOUT_MS: bad }), 30000, bad);
  }
});

test('withTimeout aborts a fetch that never answers, and passes a prompt answer through', async () => {
  let seenSignal;
  const never = (url, init) => { seenSignal = init.signal; return new Promise(() => {}); };
  const wrapped = withTimeout(never, 30);
  await assert.rejects(wrapped('https://host.test/x', { method: 'GET' }));
  assert.ok(seenSignal, 'a signal reached the wrapped fetch');
  const prompt = withTimeout(async (url, init) => ({ url, method: init.method }), 1000);
  assert.deepEqual(await prompt('https://host.test/y', { method: 'POST' }), { url: 'https://host.test/y', method: 'POST' });
  assert.deepEqual(await withTimeout(async (url, init) => ({ ok: init !== undefined }), 1000)('https://host.test/z'), { ok: true });
});

test('withTimeout keeps the caller signal working', async () => {
  const controller = new AbortController();
  const never = () => new Promise(() => {});
  const pending = withTimeout(never, 5000)('https://host.test/x', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

test('a hosted request that hangs before any headers ends as unavailable through the real api client', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason));
  });
  const tools = [{
    name: 'search', description: 'x', inputSchema: { type: 'object', additionalProperties: false },
    handler: async (args, { api }) => ({ results: await api.search('q') }),
  }];
  const openApi = async () => ({
    api: createApi({ url: 'https://host.test', credential: { kind: 'api-key', token: 'key', source: 'env' }, fetchImpl: withTimeout(hang, 30), env: {} }),
    close: () => {},
  });
  const server = createMcpServer({ tools, openApi, version: '1.0.0', mode: 'hosted' });
  const out = await server.handleLine(JSON.stringify(call('search', {})));
  assert.deepEqual(payload(JSON.parse(out)), { error: { code: 'unavailable' } });
});

test('a hosted response whose body stalls after the headers ends as unavailable through the real api client', async () => {
  const sockets = new Set();
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"skills":['); // headers and a partial body arrive; the body never ends
  });
  origin.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  try {
    const tools = [{
      name: 'search', description: 'x', inputSchema: { type: 'object', additionalProperties: false },
      handler: async (args, { api }) => ({ results: await api.search('q') }),
    }];
    const openApi = async () => ({
      api: createApi({
        url: `http://127.0.0.1:${origin.address().port}`,
        credential: { kind: 'api-key', token: 'key', source: 'env' },
        fetchImpl: withTimeout(fetch, 150),
        env: {},
      }),
      close: () => {},
    });
    const server = createMcpServer({ tools, openApi, version: '1.0.0', mode: 'hosted' });
    const out = await server.handleLine(JSON.stringify(call('search', {})));
    assert.deepEqual(payload(JSON.parse(out)), { error: { code: 'unavailable' } });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => origin.close(resolve));
  }
});

test('mapError: a timeout or abort error is unavailable and its message is not copied', () => {
  const timeout = new DOMException(`${CANARY} timed out`, 'TimeoutError');
  const abort = new DOMException(`${CANARY} aborted`, 'AbortError');
  for (const error of [timeout, abort]) {
    assert.equal(mapError(error, { mode: 'hosted' }), 'unavailable');
    assert.equal(mapError(error, { mode: 'local' }), 'unavailable');
  }
  assert.equal(mapError(Object.assign(new Error('x'), { name: 'TimeoutError' }), { mode: 'hosted' }), 'unavailable');
  assert.equal(mapError(new Error('x'), { mode: 'hosted' }), 'internal');
});

// A body read that fails after the headers surfaces as a bare TypeError from fetch (`terminated`, with the socket error as its
// cause). The rule is narrow on purpose: that message, or a network code on the error or its cause; the message is never copied.
test('mapError: a network failure while reading a body is unavailable, a programming error is internal', () => {
  const cause = (code) => Object.assign(new Error(`${CANARY} socket`), { code });
  const withCause = (message, code) => new TypeError(message, { cause: cause(code) });
  for (const mode of ['hosted', 'local']) {
    assert.equal(mapError(new TypeError('terminated', { cause: cause('UND_ERR_SOCKET') }), { mode }), 'unavailable');
    assert.equal(mapError(new TypeError('terminated'), { mode }), 'unavailable');
    assert.equal(mapError(new TypeError('fetch failed'), { mode }), 'unavailable');
    assert.equal(mapError(withCause('fetch failed', 'ECONNRESET'), { mode }), 'unavailable');
    assert.equal(mapError(withCause('anything else', 'ECONNRESET'), { mode }), 'unavailable');
    assert.equal(mapError(withCause('anything else', 'UND_ERR_BODY_TIMEOUT'), { mode }), 'unavailable');
    assert.equal(mapError(Object.assign(new Error(CANARY), { code: 'ECONNRESET' }), { mode }), 'unavailable');
    assert.equal(mapError(Object.assign(new Error(CANARY), { code: 'UND_ERR_SOCKET' }), { mode }), 'unavailable');
    // Our own code failing is still internal, whatever the class.
    assert.equal(mapError(new TypeError('Cannot read properties of undefined'), { mode }), 'internal');
    assert.equal(mapError(new TypeError('x is not a function'), { mode }), 'internal');
    assert.equal(mapError(new TypeError('terminated early'), { mode }), 'internal');
    assert.equal(mapError(new Error('terminated'), { mode }), 'internal');
    assert.equal(mapError(new Error('fetch failed'), { mode }), 'internal');
    assert.equal(mapError(withCause('x', 'EACCES'), { mode }), 'internal');
    assert.equal(mapError(Object.assign(new Error('x'), { code: 'ENOENT' }), { mode }), 'internal');
    assert.equal(mapError(new RangeError('x', { cause: cause('ECONNRESET') }), { mode }), 'unavailable');
  }
});

test('validate: a node with no type, including an enum-only node, fails closed', () => {
  assert.equal(validate({}, 'x').ok, false);
  assert.equal(validate({ enum: ['a', 'b'] }, 'a').ok, false);
  assert.equal(validate({ description: 'no type' }, 'a').ok, false);
  assert.equal(validate({ type: 'object', properties: { e: { enum: ['a'] } } }, { e: 'a' }).ok, false);
  assert.equal(validate({ type: 'array', items: {} }, ['a']).ok, false);
  // a typed node keeps the enum working
  assert.deepEqual(validate({ type: 'string', enum: ['a', 'b'] }, 'a'), { ok: true });
  assert.equal(validate({ type: 'string', enum: ['a', 'b'] }, 'c').ok, false);
});

test('validate: additionalProperties must be a boolean', () => {
  const object = (additionalProperties) => ({ type: 'object', properties: { s: { type: 'string' } }, additionalProperties });
  for (const bad of [{ type: 'string' }, {}, 'false', 0, null, [], 1]) {
    assert.equal(validate(object(bad), { s: 'a' }).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(validate(object(false), { s: 'a' }), { ok: true });
  assert.equal(validate(object(false), { s: 'a', x: 1 }).ok, false);
  assert.deepEqual(validate(object(true), { s: 'a', x: 1 }), { ok: true });
});

test('validate: a keyword that does not apply to the declared type fails closed', () => {
  const bad = [
    { type: 'integer', minLength: 1 }, { type: 'integer', maxLength: 1 }, { type: 'integer', minItems: 1 },
    { type: 'string', minimum: 1 }, { type: 'string', maximum: 1 }, { type: 'string', items: { type: 'string' } },
    { type: 'string', properties: {} }, { type: 'string', required: [] }, { type: 'string', additionalProperties: false },
    { type: 'array', minLength: 1 }, { type: 'array', minimum: 1 }, { type: 'array', properties: {} },
    { type: 'object', minLength: 1 }, { type: 'object', items: { type: 'string' } }, { type: 'object', minItems: 1 },
  ];
  const samples = { integer: 1, string: 'a', array: [], object: {} };
  for (const schema of bad) assert.equal(validate(schema, samples[schema.type]).ok, false, JSON.stringify(schema));
  // the keywords that do apply still work
  assert.deepEqual(validate({ type: 'integer', minimum: 1, maximum: 3, enum: [1, 2], description: 'd', default: 1 }, 2), { ok: true });
  assert.deepEqual(validate({ type: 'string', minLength: 1, maxLength: 3 }, 'ab'), { ok: true });
  assert.deepEqual(validate({ type: 'array', minItems: 0, maxItems: 2, items: { type: 'string' } }, ['a']), { ok: true });
  assert.deepEqual(validate({ type: 'object', properties: {}, required: [], additionalProperties: false }, {}), { ok: true });
});
