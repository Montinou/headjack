import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { access, copyFile, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MCP_TEST_CONFIG } from '../test/mcp-http-fixture.mjs';

const metadataPath = '/.well-known/oauth-protected-resource/mcp';

async function ephemeralPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopOwnedChild(child, closed) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    let timer;
    try {
      const timedOut = await Promise.race([closed.then(() => false), new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), MCP_TEST_CONFIG.shutdownMs);
      })]);
      if (timedOut) child.kill('SIGKILL');
    } finally { clearTimeout(timer); }
  }
  // exit can precede the final stdout/stderr data; close confirms both pipes are done.
  await closed;
}

export async function runNextSmoke(root = fileURLToPath(new URL('../', import.meta.url)), report = console.log) {
  await access(path.join(root, '.next/BUILD_ID'));
  const rootEnvFiles = (await readdir(root)).filter((name) => name === '.env' || name.startsWith('.env.'));
  // A fresh runtime directory prevents Next's documented .env* load order from reinjecting
  // credentials. Share the already-built artifacts; never rename, edit or read source env files.
  const runtime = await mkdtemp(path.join(tmpdir(), 'headjack-mcp-next-'));
  let child, closed;
  const output = [];
  const diagnostics = [];
  try {
    await symlink(path.join(root, '.next'), path.join(runtime, '.next'), 'dir');
    await symlink(path.join(root, 'node_modules'), path.join(runtime, 'node_modules'), 'dir');
    await copyFile(path.join(root, 'package.json'), path.join(runtime, 'package.json'));
    const env = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
    // Narrow OS-only inheritance excludes Clerk, DB, Flags, Vercel, AI and legacy configuration.
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
    assert.ok(Object.keys(env).every((key) => !/CLERK|DATABASE|^PG|NEON|FLAGS|VERCEL|MCP_|HEADJACK|GATEWAY|INWORLD|OPENAI/.test(key)));
    assert.deepEqual((await readdir(runtime)).filter((name) => name === '.env' || name.startsWith('.env.')), []);
    const port = await ephemeralPort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', runtime, '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Capture privately for assertion only: diagnostics could contain provider/config details.
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => diagnostics.push(chunk.toString()));
    closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    const deadline = Date.now() + MCP_TEST_CONFIG.readinessMs;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`${origin}${metadataPath}`, { signal: AbortSignal.timeout(MCP_TEST_CONFIG.requestMs) });
        await response.arrayBuffer();
        // Any real HTTP response proves the server is listening; endpoint assertions below determine correctness.
        ready = true; break;
      } catch { await delay(MCP_TEST_CONFIG.pollMs); }
    }
    assert.ok(ready, 'built Next server failed bounded loopback readiness');
    const responses = [];
    for (const [method, route] of [['POST', '/mcp'], ['OPTIONS', '/mcp'], ['GET', metadataPath], ['OPTIONS', metadataPath]]) {
      const response = await fetch(`${origin}${route}`, { method, signal: AbortSignal.timeout(MCP_TEST_CONFIG.requestMs),
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'default-off-smoke', version: '1' } } }) } : {}),
      });
      assert.equal(response.status, 404, `${method} ${route} must be default-off before config/provider access`);
      const body = await response.text();
      assert.equal(body, '', 'disabled endpoint must have no configuration/provider error body');
      assert.equal(response.headers.get('www-authenticate'), null);
      assert.equal(response.headers.get('set-cookie'), null);
      responses.push({ method, route, status: response.status });
    }
    await stopOwnedChild(child, closed);
    // Coordinator ruling: this exact SDK-caught fallback is allowed and counted. Every other
    // stderr diagnostic remains a failure; no generic provider/config-error suppression.
    const fallbackDiagnostic = 'flags: Flag "mcp-readonly" is falling back to its defaultValue after catching the following error Error: @vercel/flags-core: No flag definitions available. Provide a datafile or bundled definitions.';
    let fallbackCount = 0;
    let inFallbackStack = false;
    for (const line of diagnostics.join('').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
      if (line === fallbackDiagnostic) { fallbackCount++; inFallbackStack = true; continue; }
      if (inFallbackStack && /^\s+at /.test(line)) continue;
      if (line.trim() === '') { inFallbackStack = false; continue; }
      assert.fail('built Next emitted an unexpected stderr diagnostic');
    }
    assert.doesNotMatch(output.join(''), /(?:Error:|Exception|warning|publishableKey|secretKey|DATABASE_URL|MCP_RESOURCE_URL must|HEADJACK_AUTH_SERVER_URL must)/i,
      'built Next emitted an unexpected configuration/provider exception or diagnostic');
    report(JSON.stringify({ smoke: 'built-next-default-off', readinessMs: MCP_TEST_CONFIG.readinessMs,
      configuration: 'OS-only child env; isolated runtime has no .env files', sourceEnvFilesPreserved: rootEnvFiles.length, caughtFlagsFallback: { diagnostic: fallbackDiagnostic, count: fallbackCount }, responses }));
  } finally {
    try {
      if (child && closed) await stopOwnedChild(child, closed);
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
    if (child) {
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned server must exit before smoke completes');
      report(JSON.stringify({ cleanup: 'owned Next child exited; temporary runtime removed' }));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNextSmoke().catch((error) => { console.error(error instanceof assert.AssertionError ? error.message : 'Next smoke failed; inspect local setup without printing configuration'); process.exitCode = 1; });
}
