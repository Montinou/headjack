import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MCP_TRACES, checkMcpTraces } from '../../scripts/mcp-trace-check.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sv-mcp-trace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of MCP_TRACES) {
    const manifest = path.join(root, name);
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, JSON.stringify({ version: 1, files: files.map((file) => path.relative(path.dirname(manifest), path.join(root, file))) }));
  }
  return root;
}

test('both MCP traces allow compiled runtime artifacts, package metadata and dependencies', async (t) => {
  const root = await fixture(t, ['.next/server/chunks/runtime.js', 'package.json', 'node_modules/sdk/package.json']);
  assert.deepEqual(await checkMcpTraces(root), MCP_TRACES.map((manifest) => ({ manifest, files: 3, forbidden: 0 })));
});

test('both MCP traces reject private docs, tests, CLI, scripts, configs, backups, environment and scratch sources', async (t) => {
  const files = ['docs/evidence/private.png', 'test/unit/example.mjs', 'cli/harness.mjs', 'scripts/private.mjs', 'config/local.json', 'next.config.ts', '.vercel/backups/private.dump', '.env.local', '.methodology/private.md', 'scratch/private.txt', '../outside/private.txt'];
  const root = await fixture(t, files);
  assert.deepEqual(await checkMcpTraces(root), MCP_TRACES.map((manifest) => ({ manifest, files: files.length, forbidden: files.length })));
  const result = spawnSync(process.execPath, [new URL('../../scripts/mcp-trace-check.mjs', import.meta.url).pathname], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /private|harness|\.env/);
});

test('a missing second trace fails instead of silently skipping it', async (t) => {
  const root = await fixture(t, ['package.json']);
  await rm(path.join(root, MCP_TRACES[1]));
  await assert.rejects(checkMcpTraces(root), { code: 'ENOENT' });
});

test('malformed trace files fail validation', async (t) => {
  const root = await fixture(t, ['package.json']);
  await writeFile(path.join(root, MCP_TRACES[0]), JSON.stringify({ files: [null] }));
  await assert.rejects(checkMcpTraces(root), /invalid trace files/);
});
