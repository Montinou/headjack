// End to end for the npm package: pack the directory scripts/pack-npm.mjs builds, install the tarball into a scratch
// project, and run the installed `headjack`. No network: the package has no dependencies and the tarball is a local file.
// npm runs with a temp HOME and without the npm_* variables `npm run` exports (npm_config_local_prefix among them would
// point the install at this repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { tempDir } from '../helpers.mjs';
import { packNpm } from '../../scripts/pack-npm.mjs';
import { createTools } from '../../cli/mcp-tools.mjs';

const run = promisify(execFile);
const REPLY_MS = 15000;

function cleanEnv(home, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k) && !k.startsWith('HEADJACK_')));
  return { ...env, HOME: home, npm_config_cache: path.join(home, '.npm'), npm_config_update_notifier: 'false', ...extra };
}

// Sends each request line and resolves with the replies, keyed by id, once every request with an id has one.
function talk(bin, env, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const want = lines.map((l) => JSON.parse(l)).filter((m) => 'id' in m).map((m) => m.id);
    const replies = new Map();
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no reply within ${REPLY_MS} ms: ${stderr}`)); }, REPLY_MS);
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      replies.set(msg.id, msg);
      if (want.every((id) => replies.has(id))) {
        clearTimeout(timer);
        child.stdin.end();
        resolve(replies);
      }
    });
    for (const l of lines) child.stdin.write(`${l}\n`);
  });
}

test('the packed tarball installs and runs: --help, MCP initialize and tools/list', async () => {
  const work = await tempDir('hj-npm-');
  const home = path.join(work, 'home');
  const pkg = path.join(work, 'pkg');
  const project = path.join(work, 'project');
  await packNpm(pkg);
  const manifest = JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8'));

  const env = cleanEnv(home);
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', work], { cwd: pkg, env });
  const tarball = path.join(work, JSON.parse(stdout)[0].filename);

  // npm installs into the nearest parent package.json: the project holds its own.
  await run('mkdir', ['-p', project, home]);
  await writeFile(path.join(project, 'package.json'), '{"name":"smoke","version":"0.0.0","private":true}\n');
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', tarball], { cwd: project, env });

  const bin = path.join(project, 'node_modules/.bin/headjack');
  const help = await run(bin, ['--help'], { env });
  assert.match(help.stdout, /headjack/);

  const replies = await talk(bin, cleanEnv(home, { HEADJACK_MODE: 'local', HEADJACK_HOME: path.join(home, '.headjack') }), [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  ]);
  assert.equal(replies.get(1).result.serverInfo.version, manifest.version);
  assert.deepEqual(replies.get(2).result.tools.map((t) => t.name), createTools().map((t) => t.name));
});
