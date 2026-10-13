// End to end: the spawned `headjack mcp` over stdio, driven line by line. The local tests run over a temporary SQLite vault
// holding one skill and one plugin; the hosted tests use a loopback address and never reach a real server. Each child gets a
// fresh HOME, a fresh HEADJACK_HOME and a PATH of its own, so nothing of the machine running the tests leaks in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { file, tempDir } from '../helpers.mjs';
import { tokenFile } from '../../cli/credentials.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { createLocalApi } from '../../lib/local/api.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { pack } from '../../lib/tar.mjs';

const BIN = fileURLToPath(new URL('../../bin/headjack', import.meta.url));
const PLUGIN = JSON.parse(await readFile(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
const PATH_DIRS = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
const REPLY_MS = 10000; // far below the 30 s default of the request timeout, so a timeout that is not wired fails a test
const MAX_LINE = 1048576;

const skillFiles = [file('SKILL.md', '---\nname: zebra-tool\ndescription: Tracks zebra migrations\n---\n# Use\nCount zebras.')];
const SKILL_SHA = hashFiles(skillFiles);

// A vault with one approved skill and one plugin, closed before any child opens it.
async function publishFixtures(dir) {
  const { api, close } = await createLocalApi({ dir });
  try {
    await api.publish({
      slug: 'zebra-tool', name: 'zebra-tool', description: 'Tracks zebra migrations', kind: 'skill', tags: ['wildlife'],
      source: { kind: 'local' }, sha256: SKILL_SHA, status: 'approved', review_notes: 'ok', scan_flags: [],
      chunks: ['zebra-tool: Tracks zebra migrations', 'Count zebras.'],
    }, pack(skillFiles));
    const pluginFiles = [file('SKILL.md', '---\nname: toolbox\ndescription: A box of tools\n---\n# Tools')];
    await api.publish({
      slug: 'toolbox', name: 'toolbox', description: 'A box of tools', kind: 'plugin', tags: ['tools'],
      source: { kind: 'local' }, sha256: hashFiles(pluginFiles), status: 'approved', review_notes: 'ok', scan_flags: [],
      chunks: ['toolbox: A box of tools'],
    }, pack(pluginFiles));
  } finally {
    close();
  }
}

async function sandbox(extra = {}) {
  const home = await tempDir('hj-mcp-home-');
  const state = await tempDir('hj-mcp-state-');
  return { home, state, env: { HOME: home, HEADJACK_HOME: state, PATH: PATH_DIRS, ...extra } };
}

async function localSandbox(extra = {}) {
  const box = await sandbox(extra);
  await publishFixtures(box.state);
  return box;
}

// Runs `headjack mcp` and hands `use` a driver. The child is always killed when `use` ends.
async function session(env, use) {
  const child = spawn(BIN, ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const stdout = { text: '' };
  const stderr = { text: '' };
  const waiting = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr.text += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout.text += chunk;
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      lines.push(line);
      let message = null;
      try { message = JSON.parse(line); } catch { /* reported by jsonRpcLines */ }
      if (message && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  const gone = { value: null };
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      gone.value = { code, signal };
      resolve(gone.value);
    });
  });
  // An answer that can no longer come (the process is gone) fails at once, with what the process said, instead of waiting.
  const reply = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to request ${id} within ${REPLY_MS} ms`)), REPLY_MS);
    const fail = () => { clearTimeout(timer); reject(new Error(`the process ended (${JSON.stringify(gone.value)}) before answering ${id}: ${stderr.text.trim()}`)); };
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    exited.then(() => { if (waiting.has(id)) { waiting.delete(id); fail(); } }, () => {});
  });
  const driver = {
    lines, stdout, stderr, exited, child,
    // Sends a request and resolves with its answer; with `wait: false` it returns the id without waiting.
    send(method, params, { wait = true } = {}) {
      const id = nextId++;
      const answer = wait ? reply(id) : null;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return wait ? answer : id;
    },
    // The exit of the process, or a failure when it has not ended within REPLY_MS (a hang must not stall the suite).
    async exit() {
      let timer;
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the process did not end within ${REPLY_MS} ms`)), REPLY_MS); });
      try {
        return await Promise.race([exited, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    raw: (text) => child.stdin.write(text),
    end: () => child.stdin.end(),
    initialize: (params = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }) => driver.send('initialize', params),
    call: (name, args) => driver.send('tools/call', { name, arguments: args }),
  };
  try {
    return await use(driver);
  } finally {
    child.kill('SIGKILL');
    await exited.catch(() => {});
  }
}

const body = (response) => JSON.parse(response.result.content[0].text);
const errorCode = (response) => {
  assert.equal(response.result.isError, true, JSON.stringify(response));
  return body(response).error.code;
};
// Every stdout line is one JSON-RPC 2.0 message: nothing else may ever reach the channel.
function jsonRpcLines(driver) {
  assert.ok(driver.lines.length > 0, 'the server answered');
  for (const line of driver.lines) {
    let message;
    assert.doesNotThrow(() => { message = JSON.parse(line); }, `a stdout line that is not JSON: ${line.slice(0, 80)}`);
    assert.equal(message.jsonrpc, '2.0', line.slice(0, 80));
    assert.ok('result' in message || 'error' in message || 'method' in message, line.slice(0, 80));
  }
}

// A loopback server that accepts connections and never answers.
async function silentServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

// A loopback hosted server that speaks the routes `get_skill` uses. `behavior.header` is what the download sends as
// `x-skill-sha256`: a value, or null for no header at all.
async function skillServer(behavior) {
  const archive = pack(skillFiles);
  const record = {
    slug: 'zebra-tool', name: 'zebra-tool', description: 'Tracks zebra migrations', kind: 'skill', plugin_slug: null, tags: ['wildlife'],
    quality: null, source_path: null, source_kind: 'local', source_url: null, default_ref: null, commit_sha: null, sha256: SKILL_SHA,
    size: archive.length, reviewed_at: null, review_notes: null, scan_flags: [], update_available: false, latest_commit: null,
  };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ak') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }));
    } else if (req.url === '/api/skills/zebra-tool') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ skill: record }));
    } else if (req.url === '/api/skills/zebra-tool/download') {
      const headers = { 'content-type': 'application/gzip' };
      if (behavior.header !== null) headers['x-skill-sha256'] = behavior.header;
      res.writeHead(200, headers).end(archive);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
    }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

// ---- local mode ----

localTest('local mode: initialize states the mode, and the server speaks the version it was asked for', async () => {
  const { env } = await localSandbox();
  await session(env, async (mcp) => {
    const res = await mcp.initialize({ protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.deepEqual(res.result.serverInfo, { name: 'headjack', version: PLUGIN.version });
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.match(res.result.instructions, /local mode/);
    assert.match(res.result.instructions, /untrusted/);
    mcp.raw(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    assert.deepEqual(await mcp.send('ping'), { jsonrpc: '2.0', id: 2, result: {} });
    jsonRpcLines(mcp);
  });
});

// Every protocol version the server accepts is answered as asked; any other (or none) is answered with the latest.
for (const [asked, answered] of [['2025-03-26', '2025-03-26'], ['2025-06-18', '2025-06-18'], ['2099-01-01', '2025-06-18'], ['draft', '2025-06-18']]) {
  localTest(`local mode: initialize asked for protocol ${asked} answers ${answered}`, async () => {
    const { env } = await localSandbox();
    await session(env, async (mcp) => {
      const res = await mcp.initialize({ protocolVersion: asked, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.equal(res.result.protocolVersion, answered);
      assert.deepEqual(res.result.capabilities, { tools: {} });
      assert.equal(errorCode(await mcp.call('get_skill', { slug: 'no-such-skill' })), 'not_found', 'the session works at that version');
      jsonRpcLines(mcp);
    });
  });
}

localTest('local mode: tools/list, then the four tools over the vault', async () => {
  const { env } = await localSandbox();
  await session(env, async (mcp) => {
    await mcp.initialize();
    const listed = await mcp.send('tools/list');
    assert.deepEqual(listed.result.tools.map((t) => t.name), ['search_skills', 'get_skill', 'list_my_skills', 'install_command']);
    for (const t of listed.result.tools) assert.equal(t.inputSchema.additionalProperties, false, t.name);

    const found = body(await mcp.call('search_skills', { query: 'zebra' }));
    assert.deepEqual(found.results.map((r) => r.slug), ['zebra-tool']);
    assert.equal(found.results[0].update_available, false);

    const skill = body(await mcp.call('get_skill', { slug: 'zebra-tool' }));
    assert.equal(skill.slug, 'zebra-tool');
    assert.equal(skill.content_status, 'available');
    assert.equal(skill.truncated, false);
    assert.match(skill.skill_md, /Count zebras/);
    assert.equal(skill.sha256, SKILL_SHA);

    const plugin = body(await mcp.call('get_skill', { slug: 'toolbox' }));
    assert.equal(plugin.skill_md, null);
    assert.equal(plugin.content_status, 'unavailable');

    const mine = body(await mcp.call('list_my_skills', {}));
    assert.deepEqual(mine.skills.map((s) => s.slug), ['toolbox', 'zebra-tool']);
    assert.equal(mine.next_cursor, null);
    assert.deepEqual(body(await mcp.call('list_my_skills', { kind: 'plugin' })).skills.map((s) => s.slug), ['toolbox']);

    const command = body(await mcp.call('install_command', { slug: 'zebra-tool', harness: 'codex' }));
    assert.deepEqual(command, { command: "headjack add --to 'codex' --session -- 'zebra-tool'", reload_plugins: false });
    const forPlugin = body(await mcp.call('install_command', { slug: 'toolbox', harness: 'claude' }));
    assert.deepEqual(forPlugin, { command: "headjack add --to 'claude' --session -- 'toolbox'", reload_plugins: true });

    jsonRpcLines(mcp);
    assert.equal(mcp.stderr.text, '', 'a session without a problem writes nothing to stderr');
  });
});

localTest('local mode: a failure is a fixed code over the wire, never internal and never a message', async () => {
  const { env, state, home } = await localSandbox();
  await session(env, async (mcp) => {
    await mcp.initialize();
    assert.equal(errorCode(await mcp.call('install_command', { slug: 'toolbox', harness: 'codex' })), 'unsupported_harness');
    assert.equal(errorCode(await mcp.call('get_skill', { slug: 'no-such-skill' })), 'not_found');
    assert.equal(errorCode(await mcp.call('search_skills', { query: '' })), 'invalid_input');
    assert.equal(errorCode(await mcp.call('list_my_skills', { cursor: 'abc' })), 'invalid_input');
    assert.equal(errorCode(await mcp.call('nothing', {})), 'invalid_input');
    const unknown = await mcp.send('no/such/method');
    assert.equal(unknown.error.code, -32601);
    for (const text of [mcp.stdout.text, mcp.stderr.text]) {
      assert.ok(!text.includes(state) && !text.includes(home), 'no path reaches the client');
    }
    jsonRpcLines(mcp);
  });
});

// Skills whose stored text cannot be served, added to a fixture vault with the vault closed.
async function publishUnreadable(dir) {
  const bad = [file('SKILL.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))];
  const damaged = [file('SKILL.md', '---\nname: damaged-tool\ndescription: Stored archive is damaged\n---\n# Damaged')];
  const bare = [file('SKILL.md', '---\nname: bare-tool\ndescription: Stored archive is gone\n---\n# Bare')];
  const { api, close } = await createLocalApi({ dir });
  try {
    for (const [slug, files] of [['latin-tool', bad], ['damaged-tool', damaged], ['bare-tool', bare]]) {
      await api.publish({
        slug, name: slug, description: `${slug} fixture`, kind: 'skill', tags: [], source: { kind: 'local' },
        sha256: hashFiles(files), status: 'approved', review_notes: 'ok', scan_flags: [], chunks: [`${slug}: fixture`],
      }, pack(files));
    }
  } finally {
    close();
  }
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync });
  try {
    const store = (slug, blob) => db.prepare('update versions set tarball = ? where skill_id = (select id from skills where slug = ?)').run(blob, slug);
    store('damaged-tool', Buffer.from('this is not a gzip archive'));
    store('bare-tool', null);
  } finally {
    db.close();
  }
}

localTest('local mode: stored text that cannot be read is content_unavailable over the wire, a missing archive only unavailable content', async () => {
  const { env, state, home } = await localSandbox();
  await publishUnreadable(state);
  await session(env, async (mcp) => {
    await mcp.initialize();
    // Invalid UTF-8 in the stored SKILL.md and an archive that is not an archive: the metadata and the text cannot be paired.
    for (const slug of ['latin-tool', 'damaged-tool']) {
      const res = await mcp.call('get_skill', { slug });
      assert.equal(errorCode(res), 'content_unavailable', slug);
      assert.deepEqual(body(res), { error: { code: 'content_unavailable' } }, 'a fixed code and nothing else');
    }
    // No stored archive at all: the server answers 404 to the download, so the metadata alone is the answer.
    const bare = body(await mcp.call('get_skill', { slug: 'bare-tool' }));
    assert.equal(bare.slug, 'bare-tool');
    assert.deepEqual([bare.skill_md, bare.truncated, bare.content_status], [null, false, 'unavailable']);
    // The healthy skill is served as before and the process kept going.
    assert.equal(body(await mcp.call('get_skill', { slug: 'zebra-tool' })).content_status, 'available');
    for (const text of [mcp.stdout.text, mcp.stderr.text]) {
      assert.ok(!text.includes(state) && !text.includes(home), 'no path reaches the client');
    }
    jsonRpcLines(mcp);
  });
});

localTest('local mode: the warning of a lost HEADJACK_URL goes to stderr and stdout stays JSON-RPC', async () => {
  const { env, state } = await localSandbox();
  await writeFile(tokenFile(state), 'x\n', { mode: 0o600 });
  await session(env, async (mcp) => {
    await mcp.initialize();
    assert.deepEqual(body(await mcp.call('search_skills', { query: 'zebra' })).results.map((r) => r.slug), ['zebra-tool']);
    assert.match(mcp.stderr.text, /HEADJACK_URL is not set/);
    assert.doesNotMatch(mcp.stdout.text, /HEADJACK_URL/);
    jsonRpcLines(mcp);
  });
});

localTest('a damaged vault is vault_damaged, with no path and the file untouched', async () => {
  const { env, state } = await sandbox();
  const junk = Buffer.from('these are my notes, not a database\n'.repeat(40));
  await writeFile(path.join(state, 'vault.db'), junk);
  await session(env, async (mcp) => {
    const init = await mcp.initialize();
    assert.match(init.result.instructions, /local mode/);
    assert.equal(errorCode(await mcp.call('search_skills', { query: 'zebra' })), 'vault_damaged');
    assert.equal(errorCode(await mcp.call('list_my_skills', {})), 'vault_damaged');
    assert.ok(!mcp.stdout.text.includes(state));
    assert.deepEqual(await mcp.send('ping').then((r) => r.result), {}, 'the process survived');
    jsonRpcLines(mcp);
  });
  assert.deepEqual(await readFile(path.join(state, 'vault.db')), junk);
});

// ---- input handling ----

localTest('malformed input is answered and the process keeps serving', async () => {
  const { env } = await localSandbox();
  await session(env, async (mcp) => {
    await mcp.initialize();
    mcp.raw('{not json\n');
    mcp.raw('[1,2]\n');
    mcp.raw(`${JSON.stringify([{ jsonrpc: '2.0', id: 90, method: 'ping' }])}\n`);
    mcp.raw('\n\n   \n');
    assert.deepEqual((await mcp.send('ping')).result, {});
    const errors = mcp.lines.map((l) => JSON.parse(l)).filter((m) => m.error);
    assert.deepEqual(errors.map((m) => [m.id, m.error.code]), [[null, -32700], [null, -32600], [null, -32600]]);
    jsonRpcLines(mcp);
  });
});

localTest('a line over 1 MiB is refused with -32600 and the process keeps serving', async () => {
  const { env } = await localSandbox();
  await session(env, async (mcp) => {
    await mcp.initialize();
    mcp.raw(`${'x'.repeat(MAX_LINE + 100)}\n`);
    assert.deepEqual((await mcp.send('ping')).result, {});
    const refused = mcp.lines.map((l) => JSON.parse(l)).filter((m) => m.error);
    assert.equal(refused.length, 1);
    assert.deepEqual([refused[0].id, refused[0].error.code], [null, -32600]);
    jsonRpcLines(mcp);
  });
});

localTest('stdin closing ends the process with 0, with or without a request', async () => {
  const { env } = await localSandbox();
  await session(env, async (mcp) => {
    mcp.end();
    assert.deepEqual(await mcp.exit(), { code: 0, signal: null });
    assert.equal(mcp.stdout.text, '');
  });
  await session(env, async (mcp) => {
    await mcp.initialize();
    mcp.end();
    assert.deepEqual(await mcp.exit(), { code: 0, signal: null });
    jsonRpcLines(mcp);
  });
});

// ---- hosted mode and misconfiguration: the process survives and the first call reports it ----

test('hosted mode without a credential: initialize names the server, the call is unauthenticated, the process survives', async () => {
  const { env } = await sandbox({ HEADJACK_URL: 'http://127.0.0.1:9' });
  await session(env, async (mcp) => {
    const init = await mcp.initialize();
    assert.match(init.result.instructions, /hosted mode \(server http:\/\/127\.0\.0\.1:9\)/);
    assert.equal(errorCode(await mcp.call('search_skills', { query: 'zebra' })), 'unauthenticated');
    assert.equal(errorCode(await mcp.call('list_my_skills', {})), 'unauthenticated');
    assert.deepEqual((await mcp.send('ping')).result, {}, 'a later call is still served');
    assert.equal(mcp.stderr.text, '', 'the reason stays out of stderr as well');
    assert.doesNotMatch(mcp.stdout.text, /not logged in|HEADJACK_TOKEN/);
    jsonRpcLines(mcp);
  });
});

test('a bad HEADJACK_URL does not stop initialize: generic hosted text, then unauthenticated', async () => {
  for (const url of ['not a url', 'ftp://127.0.0.1', 'https://user:pw@vault.example.invalid/x?k=1']) {
    const { env } = await sandbox({ HEADJACK_URL: url });
    await session(env, async (mcp) => {
      const init = await mcp.initialize();
      assert.match(init.result.instructions, /hosted mode\./, url);
      assert.doesNotMatch(init.result.instructions, /vault\.example|pw|user/, 'no credentials in the instructions');
      assert.equal(errorCode(await mcp.call('search_skills', { query: 'zebra' })), 'unauthenticated', url);
      assert.deepEqual((await mcp.send('ping')).result, {});
      jsonRpcLines(mcp);
    });
  }
});

test('a bad HEADJACK_MODE does not stop initialize: the first call is unavailable', async () => {
  const { env } = await sandbox({ HEADJACK_MODE: 'bogus' });
  await session(env, async (mcp) => {
    const init = await mcp.initialize();
    assert.match(init.result.instructions, /untrusted/);
    assert.doesNotMatch(init.result.instructions, /local mode|hosted mode/);
    assert.equal(errorCode(await mcp.call('search_skills', { query: 'zebra' })), 'unavailable');
    assert.deepEqual((await mcp.send('ping')).result, {});
    assert.equal(mcp.stderr.text, '');
    jsonRpcLines(mcp);
  });
});

test('a hosted server that never answers ends the call as unavailable by the configured timeout', async () => {
  const server = await silentServer();
  try {
    const { env } = await sandbox({ HEADJACK_URL: server.url, HEADJACK_TOKEN: 'ak', HEADJACK_MCP_TIMEOUT_MS: '300' });
    await session(env, async (mcp) => {
      await mcp.initialize();
      const started = Date.now();
      assert.equal(errorCode(await mcp.call('search_skills', { query: 'zebra' })), 'unavailable');
      assert.ok(Date.now() - started < REPLY_MS, 'ended by the 300 ms timeout, not the 30 s default');
      assert.equal(errorCode(await mcp.call('get_skill', { slug: 'zebra-tool' })), 'unavailable', 'the queue is not blocked');
      assert.deepEqual((await mcp.send('ping')).result, {});
      jsonRpcLines(mcp);
    });
  } finally {
    await server.stop();
  }
});

test('a hosted answer past the JSON limit ends the call as unavailable, and the process keeps serving', async () => {
  const huge = JSON.stringify({ results: [{ slug: 'z', description: 'x'.repeat(9 * 1024 * 1024) }] });
  const sockets = new Set();
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(req.url.startsWith('/api/search?q=huge') ? huge : '{"results":[]}');
  });
  origin.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  try {
    const { env } = await sandbox({ HEADJACK_URL: `http://127.0.0.1:${origin.address().port}`, HEADJACK_TOKEN: 'ak' });
    await session(env, async (mcp) => {
      await mcp.initialize();
      assert.equal(errorCode(await mcp.call('search_skills', { query: 'huge' })), 'unavailable');
      assert.deepEqual(body(await mcp.call('search_skills', { query: 'small' })), { results: [] });
      jsonRpcLines(mcp);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => origin.close(resolve));
  }
});

test('stdin closing during a hung request lets it finish: the answer is flushed, then the exit is 0', async () => {
  const server = await silentServer();
  try {
    const { env } = await sandbox({ HEADJACK_URL: server.url, HEADJACK_TOKEN: 'ak', HEADJACK_MCP_TIMEOUT_MS: '300' });
    await session(env, async (mcp) => {
      await mcp.initialize();
      const id = mcp.send('tools/call', { name: 'search_skills', arguments: { query: 'zebra' } }, { wait: false });
      mcp.end();
      const { code } = await mcp.exit();
      assert.equal(code, 0);
      const answer = mcp.lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
      assert.equal(errorCode(answer), 'unavailable');
      jsonRpcLines(mcp);
    });
  } finally {
    await server.stop();
  }
});

test('hosted get_skill pairs the text with the metadata by x-skill-sha256: a match reads, a mismatch or a missing header is content_unavailable', async () => {
  const behavior = { header: SKILL_SHA };
  const server = await skillServer(behavior);
  try {
    const { env } = await sandbox({ HEADJACK_URL: server.url, HEADJACK_TOKEN: 'ak' });
    await session(env, async (mcp) => {
      await mcp.initialize();
      // The control: the header equals the record's sha256, so the text is read (the fake server speaks the contract).
      const ok = body(await mcp.call('get_skill', { slug: 'zebra-tool' }));
      assert.equal(ok.content_status, 'available');
      assert.match(ok.skill_md, /Count zebras\./);
      assert.equal(ok.sha256, SKILL_SHA);

      behavior.header = 'f'.repeat(64); // a version other than the one the record describes
      const mismatch = await mcp.call('get_skill', { slug: 'zebra-tool' });
      assert.equal(errorCode(mismatch), 'content_unavailable');
      assert.deepEqual(body(mismatch), { error: { code: 'content_unavailable' } }, 'no metadata and no text beside the code');

      behavior.header = null; // a server that does not send the header
      const missing = await mcp.call('get_skill', { slug: 'zebra-tool' });
      assert.equal(errorCode(missing), 'content_unavailable');
      assert.deepEqual(body(missing), { error: { code: 'content_unavailable' } });

      behavior.header = SKILL_SHA; // and the process is still serving
      assert.equal(body(await mcp.call('get_skill', { slug: 'zebra-tool' })).content_status, 'available');
      jsonRpcLines(mcp);
    });
  } finally {
    await server.stop();
  }
});
