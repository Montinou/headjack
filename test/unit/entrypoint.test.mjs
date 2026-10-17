import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { exec } from '../../cli/exec.mjs';
import { tempDir } from '../helpers.mjs';
import * as fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { startHeadjack, startIssuer } from '../fixtures/fake-oauth-servers.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const run = async (args, env = {}) => {
  const home = env.HOME ?? (await tempDir('sv-home-'));
  return exec('node', [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env } });
};

test('entrypoint: --help prints "headjack"', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^headjack — /);
  assert.match(help.stdout, /^  headjack search /m);
  assert.match(help.stdout, /^  headjack suggest "<text>" \[--json\] \[--explain\] \[--session-id <id>\]$/m);
  assert.match(help.stdout, /^  headjack suggest --enable \[--hosted\|--local\] \| --disable$/m);
  const config = help.stdout.slice(help.stdout.indexOf('Config:'));
  for (const piece of ['HEADJACK_URL', 'HEADJACK_TOKEN', '<state dir>/token', '$HEADJACK_HOME', '~/.headjack', 'HEADJACK_PURPOSE']) assert.ok(config.includes(piece), `${piece} in ${config}`);
  const unknown = await run(['frobnicate']);
  assert.match(unknown.stderr, /^headjack: /);
});

test('help and empty list', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /headjack search/);
  const list = await run(['list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /nothing active/);
});

test('user errors exit 2 with a message', async () => {
  const unknown = await run(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command: frobnicate/);
  const noUrl = await run(['search', 'x'], { HEADJACK_MODE: 'remote' });
  assert.equal(noUrl.code, 2);
  assert.match(noUrl.stderr, /HEADJACK_URL/);
  const missingArg = await run(['add']);
  assert.equal(missingArg.code, 2);
  assert.match(missingArg.stderr, /usage: headjack add <slug>/);
});

test('search --json against an unreachable server reports a network error', async () => {
  const res = await run(['search', 'x', '--json'], { HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't' });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /could not connect/);
});

test('add --source rejects an unknown value with exit 2', async () => {
  const res = await run(['add', 'x', '--source', 'bogus']);
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /--source expects suggest\|plan\|manual \(got: bogus\)/);
});

test('search --purpose (or HEADJACK_PURPOSE) rejects an unknown value with exit 2', async () => {
  const flag = await run(['search', 'x', '--purpose', 'bogus']);
  assert.equal(flag.code, 2, flag.stdout + flag.stderr);
  assert.match(flag.stderr, /--purpose expects suggest\|plan\|manual\|eval\|warmup \(got: bogus\)/);
  const env = await run(['search', 'x'], { HEADJACK_PURPOSE: 'bogus' });
  assert.equal(env.code, 2, env.stdout + env.stderr);
  assert.match(env.stderr, /HEADJACK_PURPOSE expects suggest\|plan\|manual\|eval\|warmup \(got: bogus\)/);
});

test('an HTTP 5xx from the vault exits 3', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unavailable', message: 'down' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await run(['search', 'x'], { HEADJACK_URL: `http://127.0.0.1:${server.address().port}`, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 3, res.stdout + res.stderr);
    assert.match(res.stderr, /headjack: down/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('help documents --source, --purpose and --if-session', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /headjack search [^\n]*\[--purpose suggest\|plan\|manual\|eval\|warmup\]/);
  assert.match(help.stdout, /headjack add <slug> [^\n]*\[--source suggest\|plan\|manual\]/);
  assert.match(help.stdout, /headjack remove <slug> [^\n]*\[--if-session\]/);
});

test('verify with nothing active exits 0', async () => {
  assert.equal((await run(['verify'])).code, 0);
});

// --- Final fix wave: entrypoint against a fake HTTP server on 127.0.0.1:0 ---

async function fakeServer(routes) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.headers.authorization === 'Bearer t' ? routes[u.pathname]?.(u, req) : undefined;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: { code: 'not_found', message: 'nope' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('search marks a plugin (and its skills) active when it is enabled in ~/.claude/settings.json', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const srv = await fakeServer({
    '/api/search': () => ({ results: [
      { slug: 'superpowers@superpowers-marketplace', kind: 'plugin', plugin_slug: null, description: 'core' },
      { slug: 'superpowers@superpowers-marketplace:brainstorming', kind: 'skill', plugin_slug: 'superpowers@superpowers-marketplace', description: 'b' },
      { slug: 'noncore-plugin@example', kind: 'plugin', plugin_slug: null, description: 'off' },
      { slug: 'humanizer', kind: 'skill', plugin_slug: null, description: 'h' },
    ] }),
  });
  try {
    const home = await tempDir('sv-home-');
    const settings = path.join(home, '.claude', 'settings.json');
    await mkdir(path.dirname(settings), { recursive: true });
    const raw = JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true, 'noncore-plugin@example': false, humanizer: true } });
    await writeFile(settings, raw);
    const res = await run(['search', 'x', '--json'], { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    const active = Object.fromEntries(JSON.parse(res.stdout).map((r) => [r.slug, r.active]));
    assert.deepEqual(active, {
      'superpowers@superpowers-marketplace': true,
      'superpowers@superpowers-marketplace:brainstorming': true,
      'noncore-plugin@example': false,
      humanizer: false,
    });
    assert.equal(await readFile(settings, 'utf8'), raw, 'read-only');
    await writeFile(settings, '{ broken');
    const broken = await run(['search', 'x', '--json'], { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(broken.code, 0, broken.stderr);
    assert.ok(JSON.parse(broken.stdout).every((r) => r.active === false));
  } finally {
    await srv.close();
  }
});

test('search sends the purpose (flag, then HEADJACK_PURPOSE, then manual) and a valid session header', async () => {
  const seen = [];
  const srv = await fakeServer({
    '/api/search': (u, req) => {
      seen.push([req.headers['x-headjack-purpose'], req.headers['x-headjack-session']]);
      return { results: [] };
    },
  });
  try {
    const env = { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' };
    for (const [args, extra] of [
      [['--purpose', 'plan'], { HEADJACK_PURPOSE: 'eval' }],
      [[], { HEADJACK_PURPOSE: 'eval', CLAUDE_CODE_SESSION_ID: 'abc-123' }],
      [[], { CLAUDE_CODE_SESSION_ID: 'bad id' }],
    ]) {
      const res = await run(['search', 'x', ...args], { ...env, ...extra });
      assert.equal(res.code, 0, res.stderr);
    }
    assert.deepEqual(seen, [['plan', undefined], ['eval', 'abc-123'], ['manual', undefined]]);
  } finally {
    await srv.close();
  }
});

test('updates prints a review hint with --path and --slug', async () => {
  const srv = await fakeServer({
    '/api/updates': () => ({ updates: [
      { slug: 'remotion-render', reviewed_commit: 'a'.repeat(40), current_commit: 'a'.repeat(40), latest_commit: 'b'.repeat(40), source_url: 'https://github.com/remotion-dev/skills', source_path: 'skills/remotion-render' },
      { slug: 'solo', reviewed_commit: 'c'.repeat(40), current_commit: 'c'.repeat(40), latest_commit: 'd'.repeat(40), source_url: 'https://github.com/me/solo', source_path: null },
    ] }),
  });
  try {
    const res = await run(['updates'], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /reviewed a{7} → latest b{7}/);
    assert.doesNotMatch(res.stdout, /\(current/, 'no parenthetical when reviewed and current match');
    assert.match(res.stdout, /\(headjack review https:\/\/github\.com\/remotion-dev\/skills --path skills\/remotion-render --slug remotion-render\)/);
    assert.match(res.stdout, /\(headjack review https:\/\/github\.com\/me\/solo --slug solo\)/);
  } finally {
    await srv.close();
  }
});

test('updates shows the current commit in parentheses when the last review was a rejection', async () => {
  const srv = await fakeServer({
    '/api/updates': () => ({ updates: [
      { slug: 'flaky', reviewed_commit: 'c'.repeat(40), current_commit: 'a'.repeat(40), latest_commit: 'd'.repeat(40), source_url: 'https://github.com/me/flaky', source_path: null },
    ] }),
  });
  try {
    const res = await run(['updates'], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /reviewed c{7} → latest d{7}\s+\(current a{7}\)/);
  } finally {
    await srv.close();
  }
});

test('audit prints the review history as a table, or JSON with --json', async () => {
  const srv = await fakeServer({
    '/api/skills/humanizer/reviews': () => ({ reviews: [
      { commit_sha: 'c'.repeat(40), status: 'rejected', reviewed_at: '2026-09-20T00:00:00.000Z', review_notes: 'too broad', sha256: '2'.repeat(64), current: false },
      { commit_sha: 'a'.repeat(40), status: 'approved', reviewed_at: '2026-09-10T00:00:00.000Z', review_notes: null, sha256: '1'.repeat(64), current: true },
    ] }),
  });
  try {
    const res = await run(['audit', 'humanizer'], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /date\s+status\s+commit\s+sha256\s+cur\s+notes/);
    assert.match(res.stdout, /2026-09-20\s+rejected\s+c{7}\s+2{7}\s*\s+too broad/);
    assert.match(res.stdout, /2026-09-10\s+approved\s+a{7}\s+1{7}\s+\*/);

    const json = await run(['audit', 'humanizer', '--json'], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).length, 2);

    const missing = await run(['audit'], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /usage: headjack audit <slug>/);
  } finally {
    await srv.close();
  }
});

test('list accepts --active', async () => {
  const res = await run(['list', '--active']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /nothing active/);
});

test('large --json output is not truncated when stdout is a pipe', async () => {
  const results = Array.from({ length: 25 }, (_, i) => ({ slug: `s${i}`, kind: 'skill', plugin_slug: null, description: 'x'.repeat(20000) }));
  const srv = await fakeServer({ '/api/search': () => ({ results }) });
  try {
    const res = await run(['search', 'x', '--json'], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).length, 25);
  } finally {
    await srv.close();
  }
});

test('import prints the entries that failed and keeps going', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const skill = path.join(home, 'mine', 'humanizer');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: humanizer\ndescription: d\n---\n# x\n');
  await mkdir(path.join(home, '.headjack'), { recursive: true });
  await writeFile(path.join(home, '.headjack', 'import-plan.json'), JSON.stringify({ entries: [
    { slug: 'humanizer', group: 'local', path: skill, source: { kind: 'local' }, source_path: null, upload: true },
  ] }));
  const srv = await fakeServer({}); // every route 404s → publish fails with a non-409 error
  try {
    const res = await run(['import'], { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /failed: humanizer \(nope\)/);
  } finally {
    await srv.close();
  }
});

test('import --trim without corePlugins says plugins are left as they are', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  await mkdir(path.join(home, '.headjack'), { recursive: true });
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.headjack', 'import-plan.json'), JSON.stringify({ entries: [] }));
  const settings = JSON.stringify({ enabledPlugins: { 'other@acme-market': true } });
  await writeFile(path.join(home, '.claude', 'settings.json'), settings);
  const line = `plugins: left as they are (no corePlugins in ${path.join(home, '.headjack', 'config.json')})`;
  for (const args of [['import', '--trim', '--dry-run'], ['import', '--trim']]) {
    const res = await run(args, { HOME: home });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.split('\n').includes(line), res.stdout);
  }
  assert.equal(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'), settings);
});

// --- Follow-up: prompts with piped (non-TTY) stdin ---

async function reviewServer() {
  const { createServer } = await import('node:http');
  const posts = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && u.pathname === '/api/skills') {
        posts.push(u.pathname);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ skillId: 1, versionId: 1 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

async function runWithStdin(args, input, env) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function localSkill() {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const dir = path.join(await tempDir('sv-src-'), 'humanizer');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: humanizer\ndescription: d\n---\n# x\n');
  return dir;
}

test('review answers every prompt from piped stdin', async () => {
  const srv = await reviewServer();
  try {
    const home = await tempDir('sv-home-');
    const res = await runWithStdin(['review', await localSkill()], 'n\na\nnotes\n', { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /humanizer: approved/);
    assert.equal(srv.posts.length, 1);
  } finally {
    await srv.close();
  }
});

test('review exits 2 when piped stdin ends before the last answer', async () => {
  const srv = await reviewServer();
  try {
    const home = await tempDir('sv-home-');
    const res = await runWithStdin(['review', await localSkill()], 'n\n', { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /headjack: input ended \(EOF\) while waiting for an answer/);
    assert.equal(srv.posts.length, 0);
  } finally {
    await srv.close();
  }
});

test('search --tag sends the tags and prints each result with its tags', async () => {
  const seen = [];
  const srv = await fakeServer({
    '/api/search': (u) => {
      seen.push(u.searchParams.getAll('tag'));
      return { results: [
        { slug: 'godot-gdscript-patterns', kind: 'skill', plugin_slug: null, description: 'GDScript patterns', tags: ['godot', 'gdscript'] },
        { slug: 'bare', kind: 'skill', plugin_slug: null, description: 'no tags', tags: [] },
      ] };
    },
  });
  try {
    const res = await run(['search', 'state machine', '--tag', 'godot,gdscript', '--tag', 'gamedev'], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(seen, [['godot,gdscript,gamedev']]);
    assert.match(res.stdout, /godot-gdscript-patterns[^\n]*\n\s+GDScript patterns\n\s+tags: godot, gdscript/);
    assert.doesNotMatch(res.stdout, /bare[^\n]*\n\s+no tags\n\s+tags:/);
  } finally {
    await srv.close();
  }
});

test('search prints alternatives as "also:" and marks a result active through an alternative install', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const srv = await fakeServer({
    '/api/search': () => ({ results: [
      { slug: 'claude-mem@acme-shared:do', kind: 'skill', plugin_slug: 'claude-mem@acme-shared', description: 'Run a plan', tags: [], alternatives: ['claude-mem@acme-market:do', 'claude-mem@other:do'] },
      { slug: 'p@shared:plan', kind: 'skill', plugin_slug: 'p@shared', description: 'Plan', alternatives: ['p@local:plan'] },
      { slug: 'q@shared:off', kind: 'skill', plugin_slug: 'q@shared', description: 'Off', alternatives: ['q@other:off'] },
      { slug: 'humanizer', kind: 'skill', plugin_slug: null, description: 'h' },
    ] }),
  });
  try {
    const home = await tempDir('sv-home-');
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem@acme-market': true, 'q@other': false } }));
    await mkdir(path.join(home, '.headjack'), { recursive: true });
    await writeFile(path.join(home, '.headjack', 'state.json'), JSON.stringify({ version: 1, active: [{ slug: 'p@local', kind: 'plugin', targets: [] }] }));
    const env = { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' };
    const json = await run(['search', 'x', '--json'], env);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(Object.fromEntries(JSON.parse(json.stdout).map((r) => [r.slug, r.active])), {
      'claude-mem@acme-shared:do': true, 'p@shared:plan': true, 'q@shared:off': false, humanizer: false,
    });
    const text = await run(['search', 'x'], env);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /● claude-mem@acme-shared:do[^\n]*\n\s+Run a plan\n\s+also: claude-mem@acme-market:do, claude-mem@other:do\n/);
    assert.match(text.stdout, /● p@shared:plan[^\n]*\n\s+Plan\n\s+also: p@local:plan/);
    assert.match(text.stdout, /○ q@shared:off/);
    assert.doesNotMatch(text.stdout, /humanizer[^\n]*\n\s+h\n\s+also/);
  } finally {
    await srv.close();
  }
});

// --- Harness registry and session installs ---

test('harness detect writes ~/.headjack/harnesses.json and prints the detected ids', async () => {
  const { mkdir, readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  for (const rel of ['.claude/skills', '.gemini/skills', '.pi/agent/skills']) await mkdir(path.join(home, rel), { recursive: true });
  const res = await run(['harness', 'detect'], { HOME: home });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^claude\s+.*\.claude\/skills$/m);
  assert.match(res.stdout, /^gemini\s+.*\.gemini\/skills$/m);
  assert.match(res.stdout, /^pi\s+.*\.pi\/agent\/skills$/m);
  assert.doesNotMatch(res.stdout, /^codex/m);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.headjack/harnesses.json'), 'utf8')).harnesses, ['claude', 'gemini', 'pi']);
  const bad = await run(['harness'], { HOME: home });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /usage: headjack harness detect/);
});

test('add --session records a session entry (plugin via a fake server)', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const srv = await fakeServer({ '/api/skills/p%40m': () => ({ skill: { slug: 'p@m', kind: 'plugin', plugin_slug: null, sha256: null } }) });
  try {
    const home = await tempDir('sv-home-');
    const res = await run(['add', 'p@m', '--session'], { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
    assert.equal(res.code, 0, res.stderr);
    const [entry] = JSON.parse(await readFile(path.join(home, '.headjack/state.json'), 'utf8')).active;
    assert.equal(entry.slug, 'p@m');
    assert.equal(entry.session, true);
    assert.ok(entry.addedAt);
  } finally {
    await srv.close();
  }
});

test('add accepts every valid --source value', async () => {
  const srv = await fakeServer({ '/api/skills/p%40m': () => ({ skill: { slug: 'p@m', kind: 'plugin', plugin_slug: null, sha256: null } }) });
  try {
    for (const source of ['suggest', 'plan', 'manual']) {
      const res = await run(['add', 'p@m', '--source', source], { HEADJACK_URL: srv.url, HEADJACK_TOKEN: 't' });
      assert.equal(res.code, 0, `${source}: ${res.stderr}`);
    }
  } finally {
    await srv.close();
  }
});

test('cleanup parses its flags, prints what it removed and exits 0 when there is nothing', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const empty = await run(['cleanup'], { HOME: home });
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /nothing to clean up/);
  const bad = await run(['cleanup', '--older-than', '1w'], { HOME: home });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--older-than expects a duration/);
  const badHarness = await run(['cleanup', '--harness', 'nope'], { HOME: home });
  assert.equal(badHarness.code, 2);
  assert.match(badHarness.stderr, /unknown harness: nope/);

  const settings = path.join(home, '.claude/settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ enabledPlugins: { 'p@m': true } }));
  await mkdir(path.join(home, '.headjack'), { recursive: true });
  const old = new Date(Date.now() - 48 * 3600e3).toISOString();
  await writeFile(path.join(home, '.headjack/state.json'), JSON.stringify({ version: 1, active: [
    { slug: 'p@m', kind: 'plugin', session: true, addedAt: old, targets: [{ harness: 'claude', settings }] },
  ] }));
  const dry = await run(['cleanup', '--harness', 'claude', '--older-than', '1d', '--dry-run'], { HOME: home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would remove: p@m \(plugin; claude\)/);
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['p@m'], true);
  const real = await run(['cleanup', '--harness', 'claude', '--older-than', '1d'], { HOME: home });
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /removed: p@m \(plugin; claude\)/);
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['p@m'], false);
});

test('import --trim --dry-run --only-harness prints per harness what would go and why the rest stays', async () => {
  const { mkdir, writeFile, readdir, access } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const md = (n) => `---\nname: ${n}\ndescription: d\n---\n# x\n`;
  const put = async (rel, content) => { await mkdir(path.dirname(path.join(home, rel)), { recursive: true }); await writeFile(path.join(home, rel), content); };
  await put('.agents/skills/humanizer/SKILL.md', md('humanizer'));
  await put('.gemini/skills/humanizer/SKILL.md', md('humanizer'));
  await put('.gemini/skills/mine/SKILL.md', md('mine'));
  await put('.gemini/skills/other/SKILL.md', md('other'));
  await put('.claude/skills/humanizer/SKILL.md', md('humanizer'));
  await put('.headjack/harnesses.json', JSON.stringify({ harnesses: ['claude', 'gemini'] }));
  const { realpath } = await import('node:fs/promises');
  await put('.headjack/import-plan.json', JSON.stringify({ entries: [
    { slug: 'humanizer', group: 'local', path: await realpath(path.join(home, '.agents/skills/humanizer')), upload: true, imported: true },
    { slug: 'other', group: 'local', path: '/x/other', upload: false },
  ] }));
  const dry = await run(['import', '--trim', '--dry-run', '--only-harness', 'gemini'], { HOME: home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: nothing is changed/);
  assert.match(dry.stdout, /^gemini \(.*\.gemini\/skills\): would remove 1, would keep 2$/m);
  assert.match(dry.stdout, /^ {2}- humanizer$/m);
  assert.match(dry.stdout, /^ {2}= mine \(not in the vault\)$/m);
  assert.match(dry.stdout, /^ {2}= other \(not imported\)$/m);
  assert.doesNotMatch(dry.stdout, /^claude/m);
  await access(path.join(home, '.gemini/skills/humanizer/SKILL.md'));
  assert.ok(!(await readdir(path.join(home, '.headjack'))).some((n) => n.startsWith('backup-')));

  const real = await run(['import', '--trim', '--only-harness', 'gemini'], { HOME: home });
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /gemini: 1 removed, 2 kept/);
  await assert.rejects(access(path.join(home, '.gemini/skills/humanizer')));
  await access(path.join(home, '.claude/skills/humanizer/SKILL.md'));
});

test('import --trim --dry-run shows the work-path reason as "under an excluded root"', async () => {
  const { mkdir, writeFile, symlink, realpath } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const md = (n) => `---\nname: ${n}\ndescription: d\n---\n# x\n`;
  const put = async (rel, content) => { await mkdir(path.dirname(path.join(home, rel)), { recursive: true }); await writeFile(path.join(home, rel), content); };
  await put('.agents/skills/humanizer/SKILL.md', md('humanizer'));
  await put('acme-work/humanizer/SKILL.md', md('humanizer'));
  await mkdir(path.join(home, '.gemini/skills'), { recursive: true });
  await symlink(path.join(home, 'acme-work/humanizer'), path.join(home, '.gemini/skills/humanizer'));
  await put('.headjack/harnesses.json', JSON.stringify({ harnesses: ['gemini'] }));
  await put('.headjack/import-plan.json', JSON.stringify({ entries: [
    { slug: 'humanizer', group: 'local', path: await realpath(path.join(home, '.agents/skills/humanizer')), upload: true, imported: true },
  ] }));
  const dry = await run(['import', '--trim', '--dry-run', '--only-harness', 'gemini'], { HOME: home, HEADJACK_EXCLUDED_ROOTS: '~/acme-work' });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^ {2}= humanizer \(under an excluded root\)$/m);
});

test('help documents harness detect, cleanup, --session and the trim flags', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /headjack add <slug> \[--to [^\]]*all[^\]]*\] \[--project\] \[--session\]/);
  assert.match(help.stdout, /headjack cleanup \[--harness <id,…>\] \[--older-than 12h\|30m\|2d\] \[--dry-run\]/);
  assert.match(help.stdout, /headjack harness detect/);
  assert.match(help.stdout, /import --trim \[--keep a,b\] \[--only-harness <id,…>\] \[--dry-run\]/);
});

// --- Fix round 1 (harness lifecycle review) ---

test('C-1: empty --only-harness, cleanup --harness and --older-than exit 2', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  await mkdir(path.join(home, '.headjack'), { recursive: true });
  await writeFile(path.join(home, '.headjack/import-plan.json'), JSON.stringify({ entries: [] }));
  for (const args of [
    ['import', '--trim', '--dry-run', '--only-harness', ''],
    ['import', '--trim', '--only-harness', ','],
    ['cleanup', '--harness', '', '--dry-run'],
    ['cleanup', '--harness', ','],
    ['cleanup', '--older-than', ''],
  ]) {
    const res = await run(args, { HOME: home });
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /--only-harness|--harness|--older-than/, args.join(' '));
  }
});

test('I-2: restore prints the dirs it could not restore and exits 1', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const backup = path.join(home, '.headjack/backup-x');
  await mkdir(path.join(backup, '.claude/skills/a'), { recursive: true });
  await writeFile(path.join(backup, '.claude/skills/a/SKILL.md'), 'a');
  await writeFile(path.join(backup, 'backup.json'), JSON.stringify({ dirs: [path.join(home, '.claude/skills'), path.join(home, '.gemini/skills')], settings: null }));
  const res = await run(['restore', backup], { HOME: home });
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /restored: 1/);
  assert.match(res.stdout, /could not restore .*\.gemini\/skills/);
});

test('I-5: --only-harness and --keep without --trim are rejected and the plan is left alone', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const plan = path.join(home, '.headjack/import-plan.json');
  await mkdir(path.dirname(plan), { recursive: true });
  const body = JSON.stringify({ entries: [{ slug: 'h', group: 'local', path: '/x/h', upload: true, imported: true }] });
  await writeFile(plan, body);
  for (const args of [['import', '--dry-run', '--only-harness', 'gemini'], ['import', '--dry-run', '--keep', 'a@b'], ['import', '--only-harness', 'gemini']]) {
    const res = await run(args, { HOME: home });
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /--trim/, args.join(' '));
  }
  assert.equal(await readFile(plan, 'utf8'), body);
});

test('M-6: cleanup prints each failure and exits 1 after removing the rest', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const bad = path.join(home, 'bad/.claude/settings.json');
  const good = path.join(home, '.claude/settings.json');
  for (const [f, body] of [[bad, '{broken'], [good, JSON.stringify({ enabledPlugins: { 'g@m': true } })]]) {
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
  }
  await mkdir(path.join(home, '.headjack'), { recursive: true });
  const at = new Date().toISOString();
  await writeFile(path.join(home, '.headjack/state.json'), JSON.stringify({ version: 1, active: [
    { slug: 'b@m', kind: 'plugin', session: true, addedAt: at, targets: [{ harness: 'claude', settings: bad }] },
    { slug: 'g@m', kind: 'plugin', session: true, addedAt: at, targets: [{ harness: 'claude', settings: good }] },
  ] }));
  const res = await run(['cleanup'], { HOME: home });
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /failed: b@m \(plugin; claude\): .*is not valid JSON/);
  assert.match(res.stdout, /removed: g@m \(plugin; claude\)/);
  assert.equal(JSON.parse(await readFile(good, 'utf8')).enabledPlugins['g@m'], false);
});

// --- Capability contract: remove --if-session ---

test('remove --if-session leaves a permanent plugin enabled, tells why, and exits 0; a missing one exits 0 too', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const settings = path.join(home, '.claude/settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ enabledPlugins: { 'p@m': true } }));
  await mkdir(path.join(home, '.headjack'), { recursive: true });
  await writeFile(path.join(home, '.headjack/state.json'), JSON.stringify({ version: 1, active: [
    { slug: 'p@m', kind: 'plugin', targets: [{ harness: 'claude', settings }] },
  ] }));
  const kept = await run(['remove', 'p@m:skill', '--if-session'], { HOME: home });
  assert.equal(kept.code, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /p@m:skill: permanent install, not removing it/);
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['p@m'], true);
  const missing = await run(['remove', 'nope', '--if-session'], { HOME: home });
  assert.equal(missing.code, 0, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /nope: not active, nothing to remove/);
});

// --- Local config: HEADJACK_HOME and lazy loading ---

test('a malformed config.json breaks only review, import and add; HEADJACK_HOME moves the state dir', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const home = await tempDir('sv-home-');
  const state = path.join(home, 'custom-state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'config.json'), 'not json');
  const env = { HOME: home, HEADJACK_HOME: '~/custom-state' };
  for (const args of [['list'], ['verify'], ['cleanup', '--dry-run']]) {
    const res = await run(args, env);
    assert.equal(res.code, 0, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
  }
  const src = path.join(home, 'src');
  await mkdir(src);
  await writeFile(path.join(src, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
  const reviewed = await run(['review', src], { ...env, HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't' });
  assert.equal(reviewed.code, 2, reviewed.stdout + reviewed.stderr);
  assert.ok(reviewed.stderr.includes(`${path.join(state, 'config.json')}: not a valid JSON object`), reviewed.stderr);
  const relative = await run(['list'], { HOME: home, HEADJACK_HOME: 'custom-state' });
  assert.equal(relative.code, 2, relative.stdout + relative.stderr);
  assert.match(relative.stderr, /HEADJACK_HOME must be an absolute path or start with ~\/ \(got "custom-state"\)/);
});

test('review of a missing path exits 2 with a one-line message and no stack', async () => {
  const home = await tempDir('sv-home-');
  const missing = `${home}/nowhere`;
  const res = await run(['review', missing], { HOME: home, HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: 't' });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), `headjack: no such path: ${missing}`);
});

// --- login, logout, whoami ---
// These runs never reach the real browser opener or the real callback ports: every login case below stops before the
// callback server starts. A successful login is covered in cli-login.test.mjs with injected ports and an injected opener.

async function stateWith(token, mode = 0o600) {
  const home = await tempDir('sv-home-');
  const dir = nodePath.join(home, '.headjack');
  await fsp.mkdir(dir, { recursive: true });
  if (token !== undefined) {
    await fsp.writeFile(nodePath.join(dir, 'token'), token);
    await fsp.chmod(nodePath.join(dir, 'token'), mode);
  }
  return { home, tokenFile: nodePath.join(dir, 'token') };
}

const oauthFile = (issuer, resource, over = {}) => JSON.stringify({
  kind: 'oauth', issuer, client_id: 'client_cli', resource, email: 'ana@example.invalid',
  access_token: 'at-entry-secret', refresh_token: 'rt-entry-secret', expires_at: Date.now() + 3600e3, ...over,
});

test('login needs only HEADJACK_URL, not a credential', async () => {
  const noUrl = await run(['login'], { HEADJACK_MODE: 'remote' });
  assert.equal(noUrl.code, 2, noUrl.stdout + noUrl.stderr);
  assert.match(noUrl.stderr, /HEADJACK_URL is not set/);
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin, discovery: false });
  try {
    const { home } = await stateWith(undefined);
    const res = await run(['login'], { HOME: home, HEADJACK_URL: headjack.origin });
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.equal(res.stderr.trim(), 'headjack: this server has not enabled CLI login');
    assert.doesNotMatch(res.stderr, /not logged in/);
  } finally {
    await Promise.all([issuer.close(), headjack.close()]);
  }
});

test('login keeps an existing credential without --force', async () => {
  const { home, tokenFile } = await stateWith(oauthFile('http://127.0.0.1:1', 'http://127.0.0.1:2/api'));
  const before = await fsp.readFile(tokenFile, 'utf8');
  const res = await run(['login'], { HOME: home, HEADJACK_URL: 'http://127.0.0.1:2' });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), 'headjack: already logged in as ana@example.invalid: use --force to log in again');
  assert.equal(await fsp.readFile(tokenFile, 'utf8'), before);
  const key = await stateWith('api-key-value\n');
  const replaced = await run(['login'], { HOME: key.home, HEADJACK_URL: 'http://127.0.0.1:2' });
  assert.equal(replaced.code, 2);
  assert.equal(replaced.stderr.trim(), 'headjack: the token file holds an API key: use --force to replace it');
});

test('login --force is a known flag and still stops on a server without CLI login', async () => {
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin, discovery: false });
  try {
    const { home } = await stateWith('api-key-value\n');
    const res = await run(['login', '--force'], { HOME: home, HEADJACK_URL: headjack.origin });
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.equal(res.stderr.trim(), 'headjack: this server has not enabled CLI login');
  } finally {
    await Promise.all([issuer.close(), headjack.close()]);
  }
});

test('logout with no credential, or with an API key, exits 2', async () => {
  const none = await stateWith(undefined);
  const res = await run(['logout'], { HOME: none.home, HEADJACK_MODE: 'remote' });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), 'headjack: not logged in');
  const key = await stateWith('api-key-value\n');
  // HEADJACK_TOKEN is ignored by logout: only the file counts.
  const withKey = await run(['logout'], { HOME: key.home, HEADJACK_TOKEN: 'env-key' });
  assert.equal(withKey.code, 2);
  assert.equal(withKey.stderr.trim(), 'headjack: API keys are revoked on the server; the token file was left in place');
  assert.equal(await fsp.readFile(key.tokenFile, 'utf8'), 'api-key-value\n');
  const envOnly = await run(['logout'], { HOME: none.home, HEADJACK_TOKEN: 'env-key', HEADJACK_MODE: 'remote' });
  assert.equal(envOnly.code, 2);
  assert.equal(envOnly.stderr.trim(), 'headjack: not logged in');
});

test('logout of an OAuth login exits 0, revokes both tokens and deletes the file', async () => {
  const issuer = await startIssuer();
  try {
    const { home, tokenFile } = await stateWith(oauthFile(issuer.origin, 'http://127.0.0.1:2/api'));
    const res = await run(['logout'], { HOME: home });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /logged out/);
    assert.equal(res.stdout.includes('entry-secret'), false);
    await assert.rejects(fsp.stat(tokenFile), { code: 'ENOENT' });
    assert.deepEqual(issuer.requests.filter((r) => r.path === '/oauth/revoke').map((r) => r.body.token_type_hint), ['refresh_token', 'access_token']);
  } finally {
    await issuer.close();
  }
});

test('logout still deletes the file when revocation fails, and says so', async () => {
  const issuer = await startIssuer({ revokeStatus: 500 });
  try {
    const { home, tokenFile } = await stateWith(oauthFile(issuer.origin, 'http://127.0.0.1:2/api'));
    const res = await run(['logout'], { HOME: home });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /could not be revoked/);
    await assert.rejects(fsp.stat(tokenFile), { code: 'ENOENT' });
  } finally {
    await issuer.close();
  }
});

test('whoami prints the credential kind, source and server status, never a token', async () => {
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin, accepted: new Set(['at-entry-secret', 'env-key-secret']) });
  try {
    const expiresAt = Date.now() + 3600e3;
    const oauth = await stateWith(oauthFile(issuer.origin, `${headjack.origin}/api`, { expires_at: expiresAt }));
    const res = await run(['whoami'], { HOME: oauth.home, HEADJACK_URL: headjack.origin });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(res.stdout, `oauth (file) ana@example.invalid, expires ${new Date(expiresAt).toISOString()}\nserver: 200\n`);

    const env = await run(['whoami'], { HOME: oauth.home, HEADJACK_URL: headjack.origin, HEADJACK_TOKEN: 'env-key-secret' });
    assert.equal(env.code, 0, env.stdout + env.stderr);
    assert.equal(env.stdout, 'api key (env)\nserver: 200\n');

    const file = await stateWith('env-key-secret\n');
    const fromFile = await run(['whoami'], { HOME: file.home, HEADJACK_URL: headjack.origin });
    assert.equal(fromFile.code, 0, fromFile.stdout + fromFile.stderr);
    assert.equal(fromFile.stdout, 'api key (file)\nserver: 200\n');

    for (const out of [res, env, fromFile]) assert.doesNotMatch(out.stdout + out.stderr, /entry-secret|key-secret/);
  } finally {
    await Promise.all([issuer.close(), headjack.close()]);
  }
});

test('whoami exits 2 when the vault rejects the credential, or when there is none', async () => {
  const issuer = await startIssuer();
  const headjack = await startHeadjack({ issuer: issuer.origin, accepted: new Set(['other']) });
  try {
    const { home } = await stateWith(undefined);
    const rejected = await run(['whoami'], { HOME: home, HEADJACK_URL: headjack.origin, HEADJACK_TOKEN: 'nope' });
    assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr);
    assert.equal(rejected.stdout, 'api key (env)\nserver: 401\n');
    const none = await run(['whoami'], { HOME: home, HEADJACK_URL: headjack.origin });
    assert.equal(none.code, 2);
    assert.equal(none.stderr.trim(), 'headjack: not logged in');
  } finally {
    await Promise.all([issuer.close(), headjack.close()]);
  }
});

test('a refresh the issuer refuses exits 2 with "session expired: run headjack login"', async () => {
  const issuer = await startIssuer({ tokenStatus: 400 });
  const headjack = await startHeadjack({ issuer: issuer.origin });
  try {
    const { home } = await stateWith(oauthFile(issuer.origin, `${headjack.origin}/api`, { expires_at: Date.now() - 1000 }));
    const res = await run(['search', 'x'], { HOME: home, HEADJACK_URL: headjack.origin });
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.equal(res.stderr.trim(), 'headjack: session expired: run headjack login');
  } finally {
    await Promise.all([issuer.close(), headjack.close()]);
  }
});

test('an issuer that cannot be reached during a refresh prints one line naming its URL', async () => {
  const headjack = await startHeadjack({ issuer: 'http://127.0.0.1:1' });
  try {
    const dead = await startIssuer();
    const deadOrigin = dead.origin;
    await dead.close();
    const { home } = await stateWith(oauthFile(deadOrigin, `${headjack.origin}/api`, { expires_at: Date.now() - 1000 }));
    const res = await run(['search', 'x'], { HOME: home, HEADJACK_URL: headjack.origin });
    assert.equal(res.code, 2, res.stdout + res.stderr);
    const lines = res.stderr.trim().split('\n');
    assert.equal(lines.length, 1, res.stderr);
    assert.ok(lines[0].startsWith('headjack: '), lines[0]);
    assert.ok(lines[0].includes(deadOrigin), lines[0]);
    assert.doesNotMatch(res.stderr, /entry-secret/);
  } finally {
    await headjack.close();
  }
});

test('a token endpoint that is down during a refresh is not "session expired": one line naming its URL', async () => {
  const dead = await startIssuer();
  const deadOrigin = dead.origin;
  await dead.close();
  const issuer = await startIssuer({ tokenEndpoint: `${deadOrigin}/oauth/token` });
  const headjack = await startHeadjack({ issuer: issuer.origin });
  try {
    const { home, tokenFile } = await stateWith(oauthFile(issuer.origin, `${headjack.origin}/api`, { expires_at: Date.now() - 1000 }));
    const before = await fsp.readFile(tokenFile, 'utf8');
    const res = await run(['search', 'x'], { HOME: home, HEADJACK_URL: headjack.origin });
    assert.equal(res.code, 2, res.stdout + res.stderr);
    const lines = res.stderr.trim().split('\n');
    assert.equal(lines.length, 1, res.stderr);
    assert.ok(lines[0].startsWith('headjack: '), lines[0]);
    assert.ok(lines[0].includes(`${deadOrigin}/oauth/token`), lines[0]);
    assert.doesNotMatch(res.stderr, /session expired|entry-secret/);
    assert.equal(await fsp.readFile(tokenFile, 'utf8'), before, 'the login is kept');
  } finally {
    await Promise.all([issuer.close(), headjack.close()]);
  }
});

test('an unexpected failure prints one line, and the stack only with HEADJACK_DEBUG', async () => {
  // A token "file" that is a directory (mode 700, so the permission check passes) fails with EISDIR, which is not a UserError.
  const home = await tempDir('sv-home-');
  await fsp.mkdir(nodePath.join(home, '.headjack', 'token'), { recursive: true, mode: 0o700 });
  await fsp.chmod(nodePath.join(home, '.headjack', 'token'), 0o700);
  const env = { HOME: home, HEADJACK_URL: 'http://127.0.0.1:2' };
  const plain = await run(['whoami'], env);
  assert.equal(plain.code, 1, plain.stdout + plain.stderr);
  assert.equal(plain.stderr.trim().split('\n').length, 1, plain.stderr);
  assert.match(plain.stderr, /^headjack: EISDIR/);
  assert.doesNotMatch(plain.stderr, /\n\s+at /);
  const debug = await run(['whoami'], { ...env, HEADJACK_DEBUG: '1' });
  assert.equal(debug.code, 1);
  assert.match(debug.stderr, /^headjack: EISDIR/);
  assert.match(debug.stderr, /\n\s+at /);
});

test('HEADJACK_URL over plain http to a non-loopback host is refused before anything is sent', async () => {
  for (const args of [['login'], ['whoami'], ['search', 'x']]) {
    const res = await run(args, { HEADJACK_URL: 'http://headjack.example.invalid', HEADJACK_TOKEN: 'secret-key' });
    assert.equal(res.code, 2, `${args[0]}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr.trim(), /^headjack: HEADJACK_URL must be an https URL[^\n]*$/);
    assert.doesNotMatch(res.stderr, /secret-key/);
  }
});

test('help documents login, logout and whoami', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^  headjack login \[--force\]$/m);
  assert.match(help.stdout, /^  headjack logout$/m);
  assert.match(help.stdout, /^  headjack whoami$/m);
  const config = help.stdout.slice(help.stdout.indexOf('Config:'));
  assert.match(config, /headjack login/);
  assert.match(config, /an API key with skills:read/);
});
