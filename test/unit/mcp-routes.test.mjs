import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { clerkConfigured } from '../../lib/clerk-config.mjs';

test('MCP routes expose explicit methods in Node and import safely without provider/DB secrets', async () => {
  const route = await import('../../app/mcp/route.ts');
  assert.equal(route.runtime, 'nodejs');
  assert.deepEqual(Object.keys(route).sort(), ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'runtime']);
  for (const method of ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']) {
    assert.equal((await route[method](new Request('https://vault.example/mcp', { method }))).status, 404);
  }
  const discovery = await import('../../app/.well-known/oauth-protected-resource/mcp/route.ts');
  assert.equal(discovery.runtime, 'nodejs');
  assert.deepEqual(Object.keys(discovery).sort(), ['GET', 'OPTIONS', 'runtime']);
  for (const method of ['GET', 'OPTIONS']) assert.equal((await discovery[method](new Request('https://vault.example/.well-known/oauth-protected-resource/mcp', { method }))).status, 404);
});

test('API discovery route is Node-only, exposes GET and OPTIONS, and is 404 without the cli-oauth flag', async () => {
  const route = await import('../../app/.well-known/oauth-protected-resource/api/route.ts');
  assert.equal(route.runtime, 'nodejs');
  assert.deepEqual(Object.keys(route).sort(), ['GET', 'OPTIONS', 'runtime']);
  for (const method of ['GET', 'OPTIONS']) assert.equal((await route[method](new Request('https://vault.example/.well-known/oauth-protected-resource/api', { method }))).status, 404);
});

test('CLI OAuth flag uses exact key/default/adapter', async () => {
  const source = await readFile(new URL('../../flags.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  const adapter = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: module.exports, module, require: (name) => name === 'flags/next' ? { flag: (descriptor) => descriptor } : { vercelAdapter: adapter },
  });
  assert.equal(module.exports.cliOauth.key, 'cli-oauth');
  assert.equal(module.exports.cliOauth.description, 'Enable CLI OAuth login discovery');
  assert.equal(module.exports.cliOauth.defaultValue, false);
  assert.equal(module.exports.cliOauth.adapter, adapter);
});

test('production MCP wiring loads Flags, SDK and app-role DB only through lazy functions', async () => {
  const source = await readFile(new URL('../../lib/mcp/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import .*from ['"](?:.*flags|.*\/app\.mjs|@clerk|.*\/repo\.mjs|.*\/embed\.mjs)/m);
  assert.match(source, /await import\(['"]\.\.\/\.\.\/flags\.ts['"]\)/);
  assert.match(source, /mcpReadOnly\(\)/);
  assert.match(source, /openAppDb\(process\.env\)/);
  assert.match(source, /evaluateSearchFlags\(\{ ownerId, sessionId \}\)/);
});

test('MCP flag uses exact key/default/adapter and preserves existing flags', async () => {
  const source = await readFile(new URL('../../flags.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  const adapter = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: module.exports, module, require: (name) => name === 'flags/next' ? { flag: (descriptor) => descriptor } : { vercelAdapter: adapter },
  });
  assert.equal(module.exports.mcpReadOnly.key, 'mcp-readonly');
  assert.equal(module.exports.mcpReadOnly.defaultValue, false);
  assert.equal(module.exports.mcpReadOnly.adapter, adapter);
  assert.equal(module.exports.clerkAuth.key, 'clerk-auth');
  assert.equal(module.exports.bilingualFts.key, 'search-bilingual-fts');
  assert.equal(module.exports.searchRanking.defaultValue, 'rrf-english');
});

async function proxyFixture(env) {
  const source = await readFile(new URL('../../proxy.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  const calls = [];
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: module.exports, module, process: { env },
    require: (name) => {
      if (name === 'next/server') return { NextResponse: { next: () => 'bypass' } };
      if (name === './lib/clerk-config.mjs') return { clerkConfigured: (config) => { calls.push('configuration'); return clerkConfigured(config); } };
      if (name === '@clerk/nextjs/server') return { clerkMiddleware: () => { calls.push('initialize'); return (req) => { calls.push(req.nextUrl.pathname); return 'clerk'; }; } };
      throw new Error(`Unexpected proxy fixture import: ${name}`);
    },
  });
  return { proxy: module.exports.default, config: module.exports.config, calls };
}

const browserPaths = ['/', '/api/skills', '/__clerk', '/__clerk/v1/client', '/mcp/child', '/mcp-extra', '/.well-known/oauth-protected-resource/mcp/child'];

test('exact MCP paths bypass configuration and Clerk; configured browser/API and auto-proxy paths retain Clerk', async () => {
  const { proxy, config, calls } = await proxyFixture({ CLERK_SECRET_KEY: 'test-secret', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'test-public' });
  for (const pathname of ['/mcp', '/.well-known/oauth-protected-resource/mcp']) assert.equal(await proxy({ nextUrl: { pathname } }, {}), 'bypass');
  assert.deepEqual(calls, []);
  for (const pathname of browserPaths) assert.equal(await proxy({ nextUrl: { pathname } }, {}), 'clerk');
  assert.equal(calls.filter((call) => call === 'initialize').length, 1);
  assert.deepEqual(calls.filter((call) => call.startsWith('/')), browserPaths);
  assert.ok(config.matcher.includes('/__clerk/:path*'));
});

test('proxy exempts the api discovery route', async () => {
  const { proxy, calls } = await proxyFixture({ CLERK_SECRET_KEY: 'test-secret', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'test-public' });
  assert.equal(await proxy({ nextUrl: { pathname: '/.well-known/oauth-protected-resource/api' } }, {}), 'bypass');
  assert.deepEqual(calls, []);
  for (const pathname of ['/.well-known/oauth-protected-resource/api/child', '/.well-known/oauth-protected-resource/apis']) assert.equal(await proxy({ nextUrl: { pathname } }, {}), 'clerk');
});

test('missing or incomplete Clerk configuration skips middleware construction for browser/API paths', async () => {
  for (const env of [{}, { CLERK_SECRET_KEY: 'test-secret' }, { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'test-public' }, { CLERK_SECRET_KEY: ' ', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'test-public' }, { CLERK_SECRET_KEY: 'test-secret', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ' ' }]) {
    const { proxy, calls } = await proxyFixture(env);
    for (const pathname of ['/mcp', '/.well-known/oauth-protected-resource/mcp']) assert.equal(await proxy({ nextUrl: { pathname } }, {}), 'bypass');
    assert.deepEqual(calls, []);
    for (const pathname of browserPaths) assert.equal(await proxy({ nextUrl: { pathname } }, {}), 'bypass');
    assert.deepEqual(calls, browserPaths.map(() => 'configuration'));
  }
});
