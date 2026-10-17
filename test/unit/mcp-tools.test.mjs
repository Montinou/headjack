import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { pack } from '../../lib/tar.mjs';
import { KNOWN_HARNESSES } from '../../cli/harness.mjs';
const secret = 'fixture-' + 'cursor-secret-at-least-32-bytes';
const context = { ownerId: 7, sessionId: 'verified-session' };
const metadata = { slug: 'own', name: 'Own', description: 'Stored skill', kind: 'skill', plugin_slug: null, tags: ['web'], quality: { reuse: 3, trigger: 2, content: 1, health: 3 }, source_path: 'skills/own', source_kind: 'github', source_url: 'https://example.test/repo', default_ref: 'main', commit_sha: 'current', sha256: 'stored', size: 12, reviewed_at: '2026-10-06', review_notes: null, scan_flags: [], update_available: true, latest_commit: 'upstream' };
const archive = pack([{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('# Stored content') }]);
async function setup(overrides = {}) {
  const { createMcpTools } = await import('../../lib/mcp/tools.mjs');
  const events = [];
  const repo = {
    consumeMcpSearchBudget: async () => { events.push('budget-committed'); return { allowed: true, retryAfter: 0 }; },
    searchVector: async (vector, limit, tags) => { events.push('vector'); assert.deepEqual(vector, [0.5]); assert.equal(limit, 50); return [{ id: 1, sim: 0.9 }]; },
    searchText: async (query, limit, tags, options) => { events.push('text'); assert.equal(limit, 50); return [1]; },
    getSkillsByIds: async () => [{ id: 1, ...metadata, active: true }],
    getMcpSkill: async (slug) => slug === 'own' ? { metadata, tarball: archive } : null,
    getSkill: async (slug) => slug === 'own' ? metadata : null,
    listMcpSkills: async () => [metadata],
    logSearchEvent: async () => { events.push('exposure'); throw new Error('MCP must never log exposures'); },
    ...overrides.repo,
  };
  const tools = createMcpTools({
    repoFor: (ownerId) => { assert.equal(ownerId, 7); return repo; },
    embed: async (queries) => { assert.deepEqual(queries, ['discover']); events.push('embed'); return [[0.5]]; },
    cursorSecret: secret, ...overrides.factory,
  });
  return { tools, events, repo };
}
const body = (response) => {
  assert.deepEqual(response.content, [{ type: 'text', text: JSON.stringify(response.structuredContent) }]);
  return response.structuredContent;
};
async function error(tools, name, input, code = 'invalid_input', ctx = context) {
  const response = await tools.call(name, input, ctx);
  assert.equal(response.isError, true);
  assert.deepEqual(body(response), { error: { code } });
}

test('all four schemas are strict, read-only descriptors and mark returned content untrusted', async () => {
  const { tools } = await setup();
  assert.deepEqual(Object.keys(tools.schemas), ['search_skills', 'get_skill', 'list_my_skills', 'install_command']);
  for (const [name, descriptor] of Object.entries(tools.schemas)) {
    assert.equal(typeof descriptor.description, 'string');
    assert.equal(descriptor.inputSchema.safeParse({ ownerId: 8 }).success, false, name);
  }
  assert.match(tools.schemas.get_skill.description, /untrusted/i);
});

const invalidSearch = [null, [], 'discover', {}, { query: '' }, { query: '  ' }, { query: 1 }, { query: 'x'.repeat(301) }, { query: 'discover', tags: null }, { query: 'discover', tags: 'web' }, { query: 'discover', tags: Array(9).fill('web') }, { query: 'discover', tags: [1] }, { query: 'discover', tags: ['x'.repeat(65)] }, ...[0, 11, 1.5, '5', null].map((k) => ({ query: 'discover', k })), { query: 'discover', ownerId: 8 }, { query: 'discover', sessionId: 'client' }, { query: 'discover', kind: 'skill' }];
for (const [index, input] of invalidSearch.entries()) test(`search input bound ${index} rejects before owner repo or embedding`, async () => {
  const { tools } = await setup({ factory: { repoFor: () => { throw new Error('validation must precede access'); } } });
  await error(tools, 'search_skills', input);
});
for (const name of ['get_skill', 'install_command']) {
  for (const [index, invalid] of [undefined, '', '  ', 1, 'x'.repeat(257), null].entries()) test(`${name} invalid slug ${index}`, async () => {
    const { tools } = await setup();
    await error(tools, name, { slug: invalid, ...(name === 'install_command' ? { harness: 'claude' } : {}) });
  });
  test(`${name} rejects unknown properties`, async () => {
    const { tools } = await setup();
    await error(tools, name, { slug: 'own', ownerId: 8, ...(name === 'install_command' ? { harness: 'claude' } : {}) });
  });
}
for (const [index, input] of [{ tag: 'x'.repeat(65) }, { tag: null }, { tag: 1 }, { kind: 'other' }, { kind: null }, { cursor: '' }, { cursor: 1 }, { cursor: 'x'.repeat(2049) }, { ownerId: 8 }].entries()) test(`listing input bound ${index}`, async () => {
  const { tools } = await setup(); await error(tools, 'list_my_skills', input);
});
for (const harness of [undefined, '', 'all', 'custom', '__proto__', 1, null]) test(`install rejects non-built-in harness ${String(harness)}`, async () => {
  const { tools } = await setup(); await error(tools, 'install_command', { slug: 'own', harness });
});

test('unknown tool and absent internal owner reject with sanitized invalid_input', async () => {
  const { tools } = await setup();
  await error(tools, 'delete_skill', { slug: 'private' });
  await error(tools, 'get_skill', { slug: 'own' }, 'invalid_input', {});
});

test('search emits only agreed fields, retains quality and consumes committed budget before embedding', async () => {
  const { tools, events } = await setup();
  const response = await tools.call('search_skills', { query: 'discover' }, context);
  assert.equal(response.isError, undefined);
  assert.deepEqual(body(response), { results: [{ slug: 'own', description: 'Stored skill', tags: ['web'], quality: { reuse: 3, trigger: 2, content: 1, health: 3 }, update_available: true }] });
  assert.deepEqual(events.slice(0, 2), ['budget-committed', 'embed']);
  assert.equal(events.includes('exposure'), false);
});

test('search defaults to five, accepts endpoints and forwards internal flag identity and exact tags', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, ...metadata, slug: `s${i}`, plugin_slug: null }));
  const { tools } = await setup({ repo: {
    searchVector: async () => rows.map((row) => ({ id: row.id, sim: 0.5 })),
    searchText: async (query, limit, tags, flags) => { assert.equal(query.length, 300); assert.deepEqual(tags, Array(8).fill('x'.repeat(64))); assert.deepEqual(flags, { bilingual: true }); return []; },
    getSkillsByIds: async () => rows,
  }, factory: { embed: async () => [[0.5]], resolveFlags: async (req, ids) => { assert.equal(req, null); assert.deepEqual(ids, context); return { bilingualFts: true, ranking: 'rrf-bilingual' }; } } });
  for (const [k, expected] of [[undefined, 5], [1, 1], [10, 10]]) {
    assert.equal(body(await tools.call('search_skills', { query: 'x'.repeat(300), tags: Array(8).fill('x'.repeat(64)), ...(k === undefined ? {} : { k }) }, context)).results.length, expected);
  }
});

test('rate limit returns retry_after without embedding, rows or exposure logs', async () => {
  const { tools, events } = await setup({ repo: { consumeMcpSearchBudget: async () => ({ allowed: false, retryAfter: 17 }) } });
  const response = await tools.call('search_skills', { query: 'discover' }, context);
  assert.deepEqual(body(response), { error: { code: 'rate_limited', retry_after: 17 } });
  assert.equal(response.isError, true); assert.deepEqual(events, []);
});

test('budget and embedding failures expose no private exception and leave consumed budget committed', async () => {
  for (const failBudget of [true, false]) {
    const { tools, events } = await setup({ ...(failBudget ? { repo: { consumeMcpSearchBudget: async () => { throw new Error('private owner token'); } } } : { factory: { embed: async () => { throw new Error('private query'); } } }) });
    await error(tools, 'search_skills', { query: 'discover' }, 'service_unavailable');
    assert.deepEqual(events, failBudget ? [] : ['budget-committed']);
  }
});

test('flag service failure falls back to English without logging input', async () => {
  const { tools } = await setup({ factory: { resolveFlags: async () => { throw new Error('private token'); } }, repo: { searchText: async (q, limit, tags, flags) => { assert.deepEqual(flags, { bilingual: false }); return [1]; } } });
  assert.equal(body(await tools.call('search_skills', { query: 'discover' }, context)).results[0].slug, 'own');
});

test('get_skill selects atomic metadata/current archive and suppresses foreign/missing existence', async () => {
  const { tools } = await setup({ repo: { getSkill: async () => { throw new Error('separate metadata is not atomic'); } } });
  assert.deepEqual(body(await tools.call('get_skill', { slug: 'own' }, context)), { ...metadata, skill_md: '# Stored content', truncated: false, content_status: 'available' });
  for (const slug of ['foreign', 'missing']) await error(tools, 'get_skill', { slug }, 'not_found');
});

test('get_skill returns unavailable plugin/null bodies and sanitized corrupt archive errors', async () => {
  for (const tarball of [null, Buffer.from('corrupt')]) {
    const { tools } = await setup({ repo: { getMcpSkill: async () => ({ metadata, tarball }) } });
    if (tarball) await error(tools, 'get_skill', { slug: 'own' }, 'content_unavailable');
    else assert.deepEqual(body(await tools.call('get_skill', { slug: 'own' }, context)), { ...metadata, skill_md: null, truncated: false, content_status: 'unavailable' });
  }
  const { tools } = await setup({ repo: { getMcpSkill: async () => ({ metadata: { ...metadata, kind: 'plugin' }, tarball: null }) } });
  assert.equal(body(await tools.call('get_skill', { slug: 'own' }, context)).content_status, 'unavailable');
});

test('listing asks for 51, emits 50 with owner/filter-bound cursor and uses last emitted slug', async () => {
  const rows = Array.from({ length: 53 }, (_, i) => ({ ...metadata, slug: `s${String(i).padStart(2, '0')}` }));
  const { tools } = await setup({ repo: { listMcpSkills: async ({ tag, kind, after, limit }) => { assert.equal(tag, 'web'); assert.equal(kind, 'skill'); assert.equal(limit, 51); return rows.filter((r) => !after || r.slug > after).slice(0, limit); } } });
  const first = body(await tools.call('list_my_skills', { tag: 'web', kind: 'skill' }, context));
  assert.equal(first.skills.length, 50); assert.equal(first.skills[49].slug, 's49'); assert.equal(typeof first.next_cursor, 'string');
  const second = body(await tools.call('list_my_skills', { tag: 'web', kind: 'skill', cursor: first.next_cursor }, context));
  assert.deepEqual(second.skills.map((r) => r.slug), ['s50', 's51', 's52']); assert.equal(second.next_cursor, null);
  await error(tools, 'list_my_skills', { tag: 'different', kind: 'skill', cursor: first.next_cursor });
  await error(tools, 'list_my_skills', { tag: 'web', kind: 'plugin', cursor: first.next_cursor });
  await error(tools, 'list_my_skills', { tag: 'web', kind: 'skill', cursor: 'x' + first.next_cursor.slice(1) });
  await error(tools, 'list_my_skills', { tag: 'web', kind: 'skill', cursor: first.next_cursor }, 'invalid_input', { ownerId: 8 });
});

test('listing emits only name, a short description head and a few tags, never the review or source detail', async () => {
  const long = 'alpha beta gamma '.repeat(30);
  const tags = ['t1', 't2', 't3', 't4', 't5'];
  const { tools } = await setup({ repo: { listMcpSkills: async () => [{ ...metadata, slug: 'own', description: long, tags, update_available: true }] } });
  const [row] = body(await tools.call('list_my_skills', {}, context)).skills;
  assert.deepEqual(Object.keys(row).sort(), ['description', 'kind', 'name', 'slug', 'tags', 'update_available']);
  assert.ok(row.description.length <= 100); assert.equal(row.description.endsWith('…'), true);
  assert.equal(/\s…$/.test(row.description), false); assert.match(row.description.slice(0, -1), /(alpha|beta|gamma)$/);
  assert.deepEqual(row.tags, ['t1', 't2', 't3']); assert.equal(row.update_available, true);
  const short = body(await (await setup({ repo: { listMcpSkills: async () => [{ ...metadata, description: 'Stored skill', tags: ['web'] }] } })).tools.call('list_my_skills', {}, context)).skills[0];
  assert.equal(short.description, 'Stored skill'); assert.deepEqual(short.tags, ['web']);
});

test('empty listing has no cursor and bounded optional tag is accepted', async () => {
  const { tools } = await setup({ repo: { listMcpSkills: async ({ tag }) => { assert.equal(tag.length, 64); return []; } } });
  assert.deepEqual(body(await tools.call('list_my_skills', { tag: 'x'.repeat(64) }, context)), { skills: [], next_cursor: null });
});

test('install command quotes metacharacters without execution and --help remains positional', async () => {
  const slug = "thing';$(touch /tmp/headjack-mcp-should-never-run);`id`";
  const { tools } = await setup({ repo: { getSkill: async (wanted) => ({ ...metadata, slug: wanted }) } });
  assert.deepEqual(body(await tools.call('install_command', { slug, harness: 'codex' }, context)), { command: "headjack add --to 'codex' --session -- 'thing'\\'';$(touch /tmp/headjack-mcp-should-never-run);`id`'", reload_plugins: false });
  const command = body(await tools.call('install_command', { slug: '--help', harness: 'claude' }, context)).command;
  assert.equal(command, "headjack add --to 'claude' --session -- '--help'");
  const parsed = parseArgs({ args: ['add', '--to', 'claude', '--session', '--', '--help'], allowPositionals: true, options: { to: { type: 'string' }, session: { type: 'boolean' }, help: { type: 'boolean' } } });
  assert.deepEqual(parsed.positionals, ['add', '--help']); assert.equal(parsed.values.help, undefined);
  assert.equal(body(await tools.call('install_command', { slug: 'x'.repeat(256), harness: 'codex' }, context)).reload_plugins, false);
});

test('standalone commands support every built-in harness and hide foreign/missing slugs', async () => {
  const { tools } = await setup();
  for (const harness of Object.keys(KNOWN_HARNESSES)) assert.deepEqual(body(await tools.call('install_command', { slug: 'own', harness }, context)), { command: `headjack add --to '${harness}' --session -- 'own'`, reload_plugins: false });
  for (const slug of ['foreign', 'missing']) await error(tools, 'install_command', { slug, harness: 'codex' }, 'not_found');
});

test('plugin kind OR non-null plugin_slug requires Claude and reload_plugins true', async () => {
  for (const row of [{ ...metadata, kind: 'plugin' }, { ...metadata, plugin_slug: 'p@m' }, { ...metadata, plugin_slug: '' }]) {
    const { tools } = await setup({ repo: { getSkill: async () => row } });
    const pluginToCodex = await tools.call('install_command', { slug: 'own', harness: 'codex' }, context);
    assert.equal(pluginToCodex.structuredContent.error.code, 'unsupported_harness');
    assert.deepEqual(body(pluginToCodex), { error: { code: 'unsupported_harness' } });
    assert.deepEqual(body(await tools.call('install_command', { slug: 'own', harness: 'claude' }, context)), { command: "headjack add --to 'claude' --session -- 'own'", reload_plugins: true });
  }
});

test('shared ranking preserves quality prior, signals, kind filtering and marketplace collapse', async () => {
  const { rankSkills } = await import('../../lib/search.mjs');
  const rows = [
    { id: 1, slug: 'plain', name: 'Plain', kind: 'skill', plugin_slug: null, quality: null },
    { id: 2, slug: 'plugin-a', name: 'Same', kind: 'plugin', plugin_slug: 'p@a', quality: { reuse: 3, trigger: 3, content: 3, health: 3 } },
    { id: 3, slug: 'plugin-b', name: 'Same', kind: 'plugin', plugin_slug: 'p@b', quality: null },
  ];
  const repo = { searchVector: async () => [{ id: 1, sim: .9 }, { id: 3, sim: .8 }], searchText: async () => [2, 3], getSkillsByIds: async () => rows };
  const ranked = await rankSkills({ repo, embed: async () => [[1]], query: 'find', tags: [], k: 3, variant: 'rrf-english' });
  assert.deepEqual(ranked.map((row) => row.slug), ['plugin-b', 'plain']);
  assert.deepEqual(ranked[0], { slug: 'plugin-b', name: 'Same', kind: 'plugin', plugin_slug: 'p@b', quality: null, review: 'approved', score: 2 / 62, fts_rank: 2, vector_rank: 2, similarity: .8, matched: 'both', variant: 'rrf-english', alternatives: ['plugin-a'] });
  const singles = await rankSkills({ repo: { ...repo, searchVector: async () => [{ id: 1, sim: .9 }], searchText: async () => [2] }, embed: async () => [[1]], query: 'find', tags: [], k: 3, variant: 'rrf-bilingual' });
  assert.deepEqual(singles.map((row) => row.slug), ['plugin-a', 'plain']);
  assert.equal(singles[0].score, 1 / 61 + .0001);
  assert.deepEqual(singles[0].quality, { reuse: 3, trigger: 3, content: 3, health: 3 });
  const skills = await rankSkills({ repo, embed: async () => [[1]], query: 'find', tags: [], k: 3, kind: 'skill', variant: 'rrf-english' });
  assert.deepEqual(skills.map((row) => row.slug), ['plain']);
});
