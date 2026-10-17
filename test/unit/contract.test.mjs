// Capability contract v3 (docs/capability-contract.md): one test per bullet, against the real CLI spawned as
// a process and a local stub vault on 127.0.0.1. The search route is served by the real `createHandlers(...).search`
// over a fake repo, so the per-result signals come from the handler, not from the stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from '../../cli/exec.mjs';
import { exitCodeFor } from '../../cli/exit.mjs';
import { createHandlers } from '../../lib/handlers.mjs';
import { createIdentity } from '../../lib/identity.mjs';
import { pack } from '../../lib/tar.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { tempDir, file } from '../helpers.mjs';
import { bearerResolver } from '../server-helpers.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const TOKEN = 't';

// Only PATH and HOME from the parent, plus whatever the test passes explicitly.
const run = async (args, env = {}) => {
  const home = env.HOME ?? (await tempDir('sv-home-'));
  return exec('node', [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env } });
};

// A stub vault. routes: { 'METHOD /pathname': (Request) => Response | Promise<Response> }; anything else is a 404.
// `seen` records every request (method, pathname, search params, headers).
async function stubVault(routes) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const u = new URL(req.url, 'http://sv.test');
    seen.push({ method: req.method, path: u.pathname, params: u.searchParams, headers: req.headers });
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)));
    const route = routes[`${req.method} ${u.pathname}`];
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const out = route
      ? await route(new Request(`http://sv.test${req.url}`, { method: req.method, headers, body }))
      : Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

// The real search handler over a fake repo whose rows carry the columns of repo.getSkillsByIds. The vector list holds
// ids 1, 2 and 4 and the text list ids 3 and 1, so id 1 is matched by both, 3 by fts only, 2 and 4 by vector only.
function realSearch() {
  const rows = [
    { id: 1, slug: 'remotion-render', name: 'remotion-render', description: 'Render', kind: 'skill', plugin_slug: null, tags: ['video'], quality: null, update_available: false },
    { id: 2, slug: 'noncore-plugin@example', name: 'noncore', description: 'A plugin', kind: 'plugin', plugin_slug: null, tags: [], quality: null, update_available: false },
    { id: 3, slug: 'humanizer', name: 'humanizer', description: 'Humanize', kind: 'skill', plugin_slug: null, tags: [], quality: null, update_available: true },
    { id: 4, slug: 'tail', name: 'tail', description: 'Last', kind: 'skill', plugin_slug: null, tags: [], quality: null, update_available: false },
  ];
  const repo = {
    searchVector: async () => [{ id: 1, sim: 0.9 }, { id: 2, sim: 0.8 }, { id: 4, sim: 0.1 }],
    searchText: async () => [3, 1],
    getSkillsByIds: async (ids) => rows.filter((r) => ids.includes(r.id)),
  };
  const identity = createIdentity({ resolvers: [bearerResolver(TOKEN)], resolveOwner: async () => 7 });
  const h = createHandlers({
    identify: identity.identify,
    repoFor: () => repo,
    listOwnerIds: async () => [7],
    embed: async (texts) => texts.map(() => Array(1536).fill(0.1)),
    env: {},
    log: () => {},
  });
  return (req) => h.search(req);
}

// Catalog of the stub vault: two skills with real tarballs, a plugin and one of its skills.
function catalog() {
  const skills = {};
  const downloads = {};
  for (const slug of ['humanizer', 'other']) {
    const files = [file('SKILL.md', `---\nname: ${slug}\ndescription: d\n---\n# ${slug}\n`)];
    const sha256 = hashFiles(files);
    skills[slug] = { slug, name: slug, kind: 'skill', plugin_slug: null, sha256 };
    downloads[slug] = { sha256, tarball: pack(files) };
  }
  skills['p@m'] = { slug: 'p@m', name: 'p', kind: 'plugin', plugin_slug: null, sha256: null };
  skills['p@m:helper'] = { slug: 'p@m:helper', name: 'helper', kind: 'skill', plugin_slug: 'p@m', sha256: null };
  skills['q@m'] = { slug: 'q@m', name: 'q', kind: 'plugin', plugin_slug: null, sha256: null };
  const routes = {};
  for (const [slug, skill] of Object.entries(skills)) {
    routes[`GET /api/skills/${encodeURIComponent(slug)}`] = () => Response.json({ skill });
  }
  for (const [slug, { sha256, tarball }] of Object.entries(downloads)) {
    routes[`GET /api/skills/${slug}/download`] = () => new Response(tarball, { headers: { 'content-type': 'application/gzip', 'x-skill-sha256': sha256 } });
  }
  routes['POST /api/events/install'] = () => new Response(null, { status: 204 });
  return routes;
}

const stateOf = async (home) => JSON.parse(await readFile(path.join(home, '.headjack/state.json'), 'utf8')).active;

test('contract: search -k N --json --purpose returns the handler fields and signals plus active', async () => {
  const srv = await stubVault({ 'GET /api/search': realSearch() });
  try {
    const home = await tempDir('sv-home-');
    await mkdir(path.join(home, '.headjack'), { recursive: true });
    await writeFile(path.join(home, '.headjack/state.json'), JSON.stringify({ version: 1, active: [
      { slug: 'humanizer', kind: 'skill', sha256: 'a'.repeat(64), targets: [] },
    ] }));
    const res = await run(['search', 'render video', '-k', '3', '--json', '--purpose', 'plan'], { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: TOKEN });
    assert.equal(res.code, 0, res.stderr);
    const [req] = srv.seen;
    assert.equal(req.params.get('k'), '3');
    assert.equal(req.headers['x-headjack-purpose'], 'plan');

    const results = JSON.parse(res.stdout);
    assert.deepEqual(results.map((r) => r.slug), ['remotion-render', 'humanizer', 'noncore-plugin@example']);
    const fields = ['slug', 'name', 'description', 'kind', 'plugin_slug', 'tags', 'update_available', 'score', 'fts_rank', 'vector_rank', 'similarity', 'matched', 'variant', 'review', 'active'];
    for (const r of results) {
      for (const f of fields) assert.ok(Object.hasOwn(r, f), `${r.slug} lacks ${f}`);
      assert.ok(!Object.hasOwn(r, 'id') && !Object.hasOwn(r, 'quality'), `${r.slug} leaks internal columns`);
      assert.equal(typeof r.score, 'number');
      assert.ok(r.fts_rank === null || (Number.isInteger(r.fts_rank) && r.fts_rank >= 1));
      assert.ok(r.vector_rank === null || (Number.isInteger(r.vector_rank) && r.vector_rank >= 1));
      assert.ok(r.similarity === null || typeof r.similarity === 'number');
      assert.equal(typeof r.active, 'boolean');
      assert.ok(r.review === 'approved' || r.review === 'unreviewed', `${r.slug} review: ${r.review}`);
    }
    const by = Object.fromEntries(results.map((r) => [r.slug, r]));
    assert.deepEqual(
      Object.fromEntries(results.map((r) => [r.slug, [r.matched, r.fts_rank, r.vector_rank, r.similarity, r.variant, r.active]])),
      {
        'remotion-render': ['both', 2, 1, 0.9, 'rrf-english', false],
        humanizer: ['fts', 1, null, null, 'rrf-english', true],
        'noncore-plugin@example': ['vector', null, 2, 0.8, 'rrf-english', false],
      },
    );
    assert.equal(by.humanizer.update_available, true);
  } finally {
    await srv.close();
  }
});

test('contract: add exits 0 on success and again when the slug is already installed', async () => {
  const srv = await stubVault(catalog());
  try {
    const home = await tempDir('sv-home-');
    const env = { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: TOKEN };
    const first = await run(['add', 'humanizer', '--to', 'claude'], env);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const second = await run(['add', 'humanizer', '--to', 'claude'], env);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    const entries = await stateOf(home);
    assert.deepEqual(entries.map((e) => e.slug), ['humanizer']);
    assert.ok((await lstat(path.join(home, '.claude/skills/humanizer'))).isSymbolicLink());
  } finally {
    await srv.close();
  }
});

// One HOME with a permanent skill, a session skill and a plugin installed through a plugin skill's vault slug.
async function installedHome() {
  const srv = await stubVault(catalog());
  const home = await tempDir('sv-home-');
  const env = { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: TOKEN };
  try {
    for (const args of [['add', 'humanizer', '--to', 'claude'], ['add', 'other', '--to', 'claude', '--session'], ['add', 'p@m:helper', '--to', 'claude']]) {
      const res = await run(args, env);
      assert.equal(res.code, 0, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    }
  } finally {
    await srv.close();
  }
  const res = await run(['list', '--json'], { HOME: home });
  assert.equal(res.code, 0, res.stderr);
  const entries = JSON.parse(res.stdout);
  return { home, entries, entry: (slug) => entries.find((e) => e.slug === slug) };
}

const keysOf = (o) => Object.keys(o).sort();

test('contract: list --json shape of a permanent skill entry (no session, no addedAt)', async () => {
  const { entry } = await installedHome();
  const e = entry('humanizer');
  assert.deepEqual(keysOf(e), ['kind', 'sha256', 'slug', 'targets']);
  assert.equal(e.kind, 'skill');
  assert.match(e.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(e.targets) && e.targets.length === 1);
  assert.equal(e.targets[0].harness, 'claude');
});

test('contract: list --json shape of a session skill entry (session: true and addedAt)', async () => {
  const { entry } = await installedHome();
  const e = entry('other');
  assert.deepEqual(keysOf(e), ['addedAt', 'kind', 'session', 'sha256', 'slug', 'targets']);
  assert.equal(e.kind, 'skill');
  assert.equal(e.session, true);
  assert.ok(!Number.isNaN(Date.parse(e.addedAt)), e.addedAt);
  assert.match(e.sha256, /^[0-9a-f]{64}$/);
});

test('contract: list --json shape of a plugin entry, keyed by the plugin key (no sha256)', async () => {
  const { entries, entry } = await installedHome();
  assert.equal(entry('p@m:helper'), undefined, 'a plugin skill has no entry of its own');
  const e = entry('p@m');
  assert.deepEqual(keysOf(e), ['kind', 'slug', 'targets']);
  assert.equal(e.kind, 'plugin');
  assert.ok(Array.isArray(e.targets) && e.targets.length === 1);
  assert.equal(entries.length, 3);
});

test('contract: remove --if-session exits 0 for a session, a permanent and an inactive slug; cleanup removes session entries', async () => {
  const srv = await stubVault(catalog());
  try {
    const home = await tempDir('sv-home-');
    const env = { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: TOKEN };
    for (const args of [['add', 'humanizer', '--to', 'claude', '--session'], ['add', 'p@m:helper'], ['add', 'q@m', '--session']]) {
      const res = await run(args, env);
      assert.equal(res.code, 0, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    }
    const settings = path.join(home, '.claude/settings.json');

    const session = await run(['remove', 'humanizer', '--if-session'], { HOME: home });
    assert.equal(session.code, 0, session.stdout + session.stderr);
    await assert.rejects(lstat(path.join(home, '.claude/skills/humanizer')), { code: 'ENOENT' });

    const permanent = await run(['remove', 'p@m:helper', '--if-session'], { HOME: home });
    assert.equal(permanent.code, 0, permanent.stdout + permanent.stderr);
    assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['p@m'], true);

    const inactive = await run(['remove', 'nope', '--if-session'], { HOME: home });
    assert.equal(inactive.code, 0, inactive.stdout + inactive.stderr);
    assert.deepEqual((await stateOf(home)).map((e) => e.slug).sort(), ['p@m', 'q@m']);

    const cleanup = await run(['cleanup'], { HOME: home });
    assert.equal(cleanup.code, 0, cleanup.stdout + cleanup.stderr);
    assert.deepEqual((await stateOf(home)).map((e) => e.slug), ['p@m']);
    assert.equal(JSON.parse(await readFile(settings, 'utf8')).enabledPlugins['q@m'], false);
  } finally {
    await srv.close();
  }
});

test('contract: exit codes 0 success, 2 user and non-transient API errors, 3 network or 5xx, 1 unexpected or failed items', async () => {
  assert.equal((await run(['list', '--json'])).code, 0);
  const unknownOption = await run(['list', '--bogus']);
  assert.equal(unknownOption.code, 2, unknownOption.stdout + unknownOption.stderr);

  const unreachable = await run(['search', 'x', '--json'], { HEADJACK_URL: 'http://127.0.0.1:9', HEADJACK_TOKEN: TOKEN });
  assert.equal(unreachable.code, 3, unreachable.stdout + unreachable.stderr);

  const srv = await stubVault({
    'GET /api/search': (req) => (new URL(req.url).searchParams.get('q') === 'down'
      ? Response.json({ error: { code: 'unavailable', message: 'down' } }, { status: 503 })
      : Response.json({ error: { code: 'bad_request', message: 'bad' } }, { status: 400 })),
  });
  try {
    const env = { HEADJACK_URL: srv.url, HEADJACK_TOKEN: TOKEN };
    const unavailable = await run(['search', 'down'], env);
    assert.equal(unavailable.code, 3, unavailable.stdout + unavailable.stderr);
    const badRequest = await run(['search', 'x'], env);
    assert.equal(badRequest.code, 2, badRequest.stdout + badRequest.stderr);
  } finally {
    await srv.close();
  }

  // An unexpected error cannot be provoked through the CLI without breaking it; the mapping itself is pinned.
  assert.equal(exitCodeFor(new Error('x')), 1);
  // A command that reports a failed item: cleanup of a session plugin whose settings file is corrupt.
  const home = await tempDir('sv-home-');
  const bad = path.join(home, '.claude/settings.json');
  await mkdir(path.dirname(bad), { recursive: true });
  await writeFile(bad, '{broken');
  await mkdir(path.join(home, '.headjack'), { recursive: true });
  await writeFile(path.join(home, '.headjack/state.json'), JSON.stringify({ version: 1, active: [
    { slug: 'b@m', kind: 'plugin', session: true, addedAt: new Date().toISOString(), targets: [{ harness: 'claude', settings: bad }] },
  ] }));
  const failedItem = await run(['cleanup'], { HOME: home });
  assert.equal(failedItem.code, 1, failedItem.stdout + failedItem.stderr);
});

test('contract: environment inputs HEADJACK_URL, HEADJACK_TOKEN, CLAUDE_CODE_SESSION_ID, HEADJACK_PURPOSE', async () => {
  const srv = await stubVault({ 'GET /api/search': realSearch() });
  try {
    const res = await run(['search', 'x', '--json'], {
      HEADJACK_URL: srv.url,
      HEADJACK_TOKEN: TOKEN,
      CLAUDE_CODE_SESSION_ID: 'sess-123',
      HEADJACK_PURPOSE: 'eval',
    });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(srv.seen.length, 1);
    const { headers } = srv.seen[0];
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(headers['x-headjack-session'], 'sess-123');
    assert.equal(headers['x-headjack-purpose'], 'eval');
  } finally {
    await srv.close();
  }
});

test('contract: a failing install event endpoint does not change the exit code of add', async () => {
  const routes = catalog();
  routes['POST /api/events/install'] = () => Response.json({ error: { code: 'internal', message: 'internal error' } }, { status: 500 });
  const srv = await stubVault(routes);
  try {
    const home = await tempDir('sv-home-');
    const res = await run(['add', 'q@m'], { HOME: home, HEADJACK_URL: srv.url, HEADJACK_TOKEN: TOKEN });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(srv.seen.some((r) => r.method === 'POST' && r.path === '/api/events/install'), 'the event was attempted');
    assert.deepEqual((await stateOf(home)).map((e) => e.slug), ['q@m']);
  } finally {
    await srv.close();
  }
});

test('contract: the document states version 3 and lists review, the extended active and the suggest command', async () => {
  const doc = await readFile(new URL('../../docs/capability-contract.md', import.meta.url), 'utf8');
  assert.match(doc, /^Contract version: 3$/m);
  for (const piece of ['`review`', 'approved', 'unreviewed', 'skill directories', '`suggest "<text>"', '--session-id', '--enable', 'skipped:no-vault', '`error`', '1 for the `error` outcome']) {
    assert.ok(doc.includes(piece), `the contract document lacks ${piece}`);
  }
});

test('contract: suggest exits 0 and prints nothing for a user with no local vault; a bad --session-id exits 2', async () => {
  const home = await tempDir('sv-home-');
  const quiet = await run(['suggest', 'please run my recurring jobs periodically using cron'], { HOME: home, HEADJACK_HOME: path.join(home, 'hj') });
  assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr);
  assert.equal(quiet.stdout, '');
  const bad = await run(['suggest', 'please run my recurring jobs periodically using cron', '--session-id', '../x'], { HOME: home, HEADJACK_HOME: path.join(home, 'hj') });
  assert.equal(bad.code, 2, bad.stdout + bad.stderr);
});
