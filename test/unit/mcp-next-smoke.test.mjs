import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runNextSmoke } from '../../scripts/mcp-next-smoke.mjs';
import { MCP_TEST_CONFIG } from '../mcp-http-fixture.mjs';

const fallbackDiagnostic = 'flags: Flag "mcp-readonly" is falling back to its defaultValue after catching the following error Error: @vercel/flags-core: No flag definitions available. Provide a datafile or bundled definitions.';
const timeout = MCP_TEST_CONFIG.readinessMs + 5 * MCP_TEST_CONFIG.requestMs + 2 * MCP_TEST_CONFIG.shutdownMs;

async function fixture(t, { lateStream = null, status = 404 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sv-mcp-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.next'));
  await mkdir(path.join(root, 'node_modules/next/dist/bin'), { recursive: true });
  await writeFile(path.join(root, '.next/BUILD_ID'), 'fixture');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const marker = path.join(root, 'shutdown.json');
  // This real owned child handles the same HTTP requests and OS shutdown as Next.
  // Its late diagnostic is emitted only after SIGTERM, beyond the old validation point.
  await writeFile(path.join(root, 'node_modules/next/dist/bin/next'), `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      process.stderr.write(${JSON.stringify(fallbackDiagnostic)} + '\\n    at fixture (fixture:1:1)\\n');
      res.writeHead(${status}); res.end();
    });
    server.listen(port, '127.0.0.1');
    process.once('SIGTERM', () => {
      setTimeout(() => {
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, runtime: process.cwd(), requests }));
        const stream = ${JSON.stringify(lateStream)};
        server.close(() => {
          if (stream) process[stream].write('Error: late provider diagnostic\\n', () => process.exit(0));
          else process.exit(0);
        });
        server.closeAllConnections();
      }, ${MCP_TEST_CONFIG.pollMs});
    });
  `);
  return { root, marker };
}

async function assertCleanup(marker, reports) {
  const { pid, runtime, requests } = JSON.parse(await readFile(marker, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the owned child must have terminated');
  await assert.rejects(access(runtime), { code: 'ENOENT' }, 'the isolated runtime must be removed');
  assert.equal(reports.at(-1).cleanup, 'owned Next child exited; temporary runtime removed');
  return requests;
}

for (const lateStream of ['stderr', 'stdout']) {
  test(`rejects unexpected ${lateStream} emitted by the real owned child during shutdown`, { timeout }, async (t) => {
    const { root, marker } = await fixture(t, { lateStream });
    const reports = [];
    await assert.rejects(runNextSmoke(root, (message) => reports.push(JSON.parse(message))),
      /built Next emitted an unexpected/);
    assert.equal(reports.some((report) => report.smoke), false, 'failure must never emit smoke success');
    assert.equal(await assertCleanup(marker, reports), 5);
  });
}

test('success follows owned child shutdown and reports the exact allowed Flags count', { timeout }, async (t) => {
  const { root, marker } = await fixture(t);
  const reports = [];
  await runNextSmoke(root, (message) => {
    const report = JSON.parse(message);
    if (report.smoke) {
      const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'success must follow owned child termination');
    }
    reports.push(report);
  });
  assert.equal(await assertCleanup(marker, reports), 5);
  assert.deepEqual(reports.find((report) => report.smoke).caughtFlagsFallback, { diagnostic: fallbackDiagnostic, count: 5 });
  assert.equal(reports.find((report) => report.smoke).responses.length, 4);
});

test('a failed endpoint assertion still terminates the owned child and removes its runtime', { timeout }, async (t) => {
  const { root, marker } = await fixture(t, { status: 500 });
  const reports = [];
  await assert.rejects(runNextSmoke(root, (message) => reports.push(JSON.parse(message))), /must be default-off/);
  assert.equal(reports.some((report) => report.smoke), false);
  assert.equal(await assertCleanup(marker, reports), 2);
});
