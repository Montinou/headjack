// The tools of the local MCP server (cli/mcp-tools.mjs) and the skill reader (cli/mcp-content.mjs). The api is always a
// fake object; the tarballs are real archives made with lib/tar.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError, createApi } from '../../cli/api.mjs';
import { createMcpServer } from '../../cli/mcp.mjs';
import { validate } from '../../cli/mcp-schema.mjs';
import { readSkillContent } from '../../cli/mcp-content.mjs';
import { createTools, shellQuote, stripCredentials } from '../../cli/mcp-tools.mjs';
import { KNOWN_HARNESSES } from '../../lib/harness-catalog.mjs';
import { pack, unpack } from '../../lib/tar.mjs';

const CANARY = 'canaryword';
const SHA = 'a'.repeat(64);
const MIB = 1024 * 1024;
const tools = createTools();
const tool = (name) => tools.find((candidate) => candidate.name === name);

// A fake api: each method is optional; a method the test did not give throws when called, and every call is recorded.
function makeApi(methods = {}) {
  const calls = [];
  const api = {};
  for (const name of ['search', 'getSkill', 'download', 'list']) {
    api[name] = async (...args) => {
      calls.push([name, ...args]);
      if (!methods[name]) throw new Error(`unexpected api.${name} call`);
      return methods[name](...args);
    };
  }
  return { api, calls };
}

const skillRow = (extra = {}) => ({
  slug: 'demo', name: 'Demo', description: 'A demo skill', kind: 'skill', plugin_slug: null, tags: ['a', 'b'], quality: 0.9,
  source_path: 'skills/demo', source_kind: 'git', source_url: 'https://example.invalid/org/demo.git', default_ref: 'main',
  commit_sha: 'abc123', sha256: SHA, size: 10, reviewed_at: '2026-01-01T00:00:00Z', review_notes: null, scan_flags: [],
  update_available: 0, latest_commit: null, ...extra,
});
const archive = (files) => pack(Object.entries(files).map(([file, data]) => ({ path: file, mode: 0o644, data: Buffer.from(data) })));
const tar = (skillMd) => archive({ 'SKILL.md': skillMd });
const run = (name, args, api) => tool(name).handler(args, { api });
const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return assert.fail('expected a rejection');
};

// ---- the set of tools and their schemas ----

test('createTools: the four tools, each with a description, a schema and a handler', () => {
  assert.deepEqual(tools.map((t) => t.name), ['search_skills', 'get_skill', 'list_my_skills', 'install_command']);
  for (const t of tools) {
    assert.equal(typeof t.description, 'string', t.name);
    assert.match(t.description, /untrusted/i, `${t.name} says that skill content is untrusted`);
    assert.match(t.description, /run headjack login/, `${t.name} carries the hosted-mode advice`);
    assert.equal(typeof t.handler, 'function', t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
  }
  assert.notEqual(createTools(), tools, 'each call builds its own list');
});

// A value that visits every node of a schema: the validator checks lazily along the value's path, so only such a value
// proves each node typed and each keyword applicable.
function sampleFor(schema, where) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${where}: a node is an object`);
  assert.equal(typeof schema.type, 'string', `${where}: every node has a type`);
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case 'string': return 'x'.repeat(Math.max(1, schema.minLength ?? 0));
    case 'integer': return schema.minimum ?? 0;
    case 'array':
      assert.ok(schema.items, `${where}: an array declares its items`);
      return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () => sampleFor(schema.items, `${where}[]`));
    case 'object': {
      assert.equal(schema.additionalProperties, false, `${where}: an object closes additionalProperties`);
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) assert.ok(Object.hasOwn(properties, key), `${where}: required ${key} is declared`);
      return Object.fromEntries(Object.entries(properties).map(([key, node]) => [key, sampleFor(node, `${where}.${key}`)]));
    }
    default: return assert.fail(`${where}: unsupported type ${schema.type}`);
  }
}

test('every node of every tool schema is valid under the fail-closed validator', () => {
  // The control: the walk below would be worthless if the validator let an untyped node through a visited path.
  assert.equal(validate({ type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 'x' }).ok, false);
  assert.equal(validate({ type: 'object', properties: { a: { type: 'string', minimum: 1 } }, additionalProperties: false }, { a: 'x' }).ok, false);
  for (const t of tools) {
    const value = sampleFor(t.inputSchema, t.name);
    const result = validate(t.inputSchema, value);
    assert.equal(result.ok, true, `${t.name}: ${result.reason}`);
    assert.equal(validate(t.inputSchema, { ...value, extra: 1 }).ok, false, `${t.name} rejects an unknown property`);
  }
});

test('the schemas enforce the documented bounds', () => {
  const ok = (name, args) => validate(tool(name).inputSchema, args).ok;
  assert.equal(ok('search_skills', { query: 'x'.repeat(300) }), true);
  assert.equal(ok('search_skills', {}), false);
  assert.equal(ok('search_skills', { query: '' }), false);
  assert.equal(ok('search_skills', { query: 'x'.repeat(301) }), false);
  assert.equal(ok('search_skills', { query: 'q', k: 10 }), true);
  assert.equal(ok('search_skills', { query: 'q', k: 0 }), false);
  assert.equal(ok('search_skills', { query: 'q', k: 11 }), false);
  assert.equal(ok('search_skills', { query: 'q', k: 1.5 }), false);
  assert.equal(ok('search_skills', { query: 'q', tags: Array(8).fill('t') }), true);
  assert.equal(ok('search_skills', { query: 'q', tags: Array(9).fill('t') }), false);
  assert.equal(ok('search_skills', { query: 'q', tags: [''] }), false);
  assert.equal(ok('search_skills', { query: 'q', tags: ['t'.repeat(65)] }), false);
  assert.equal(ok('get_skill', { slug: 's'.repeat(256) }), true);
  assert.equal(ok('get_skill', { slug: 's'.repeat(257) }), false);
  assert.equal(ok('get_skill', { slug: '' }), false);
  assert.equal(ok('list_my_skills', {}), true);
  assert.equal(ok('list_my_skills', { kind: 'plugin', tag: 't', cursor: '50' }), true);
  assert.equal(ok('list_my_skills', { kind: 'other' }), false);
  assert.equal(ok('list_my_skills', { cursor: 50 }), false);
  assert.equal(ok('install_command', { slug: 's', harness: 'claude' }), true);
  assert.equal(ok('install_command', { slug: 's', harness: 'nope' }), false);
  assert.equal(ok('install_command', { slug: 's' }), false);
  for (const harness of Object.keys(KNOWN_HARNESSES)) assert.equal(ok('install_command', { slug: 's', harness }), true, harness);
});

// ---- search_skills ----

test('search_skills calls api.search as a manual search and maps the rows without quality', async () => {
  const { api, calls } = makeApi({
    search: async () => [
      { slug: 'a', kind: 'skill', description: 'first', tags: ['x'], quality: 0.9, update_available: 1, score: 3, name: 'A' },
      { slug: 'b', kind: 'plugin', description: 'second', tags: [], quality: 0.1, update_available: false },
    ],
  });
  const out = await run('search_skills', { query: 'find me', k: 3, tags: ['t1', 't2'] }, api);
  assert.deepEqual(calls, [['search', 'find me', 3, undefined, ['t1', 't2'], 'manual']]);
  assert.deepEqual(out, {
    results: [
      { slug: 'a', kind: 'skill', description: 'first', tags: ['x'], update_available: true },
      { slug: 'b', kind: 'plugin', description: 'second', tags: [], update_available: false },
    ],
  });
  assert.doesNotMatch(JSON.stringify(out), /quality/);
});

test('search_skills defaults k to 5 and tags to none, and an empty result is an empty list', async () => {
  const { api, calls } = makeApi({ search: async () => [] });
  assert.deepEqual(await run('search_skills', { query: 'q' }, api), { results: [] });
  assert.deepEqual(calls, [['search', 'q', 5, undefined, [], 'manual']]);
});

test('search_skills never uses the suggest purpose and refuses a blank query', async () => {
  const { api, calls } = makeApi({ search: async () => [] });
  assert.equal(await codeOf(run('search_skills', { query: '   ' }, api)), 'invalid_input');
  assert.deepEqual(calls, []);
  await run('search_skills', { query: 'q' }, api);
  assert.ok(calls.every((call) => call[5] === 'manual' && !call.includes('suggest')));
});

// ---- get_skill ----

test('get_skill returns the metadata plus the SKILL.md of a normal skill', async () => {
  const text = '---\nname: demo\n---\n# Demo\n';
  const { api, calls } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: tar(text) }) });
  const out = await run('get_skill', { slug: 'demo' }, api);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [['getSkill', 'demo'], ['download', 'demo']]);
  assert.deepEqual(out, { ...skillRow(), update_available: false, skill_md: text, truncated: false, content_status: 'available' });
});

test('get_skill does not download a plugin', async () => {
  for (const extra of [{ kind: 'plugin' }, { plugin_slug: 'some-plugin' }]) {
    const { api, calls } = makeApi({ getSkill: async () => skillRow(extra) });
    const out = await run('get_skill', { slug: 'demo' }, api);
    assert.deepEqual(calls.map((call) => call[0]), ['getSkill']);
    assert.equal(out.skill_md, null);
    assert.equal(out.truncated, false);
    assert.equal(out.content_status, 'unavailable');
    assert.equal(out.slug, 'demo');
  }
});

test('get_skill: an unknown slug is not_found and nothing is downloaded', async () => {
  const { api, calls } = makeApi({ getSkill: async () => null });
  assert.equal(await codeOf(run('get_skill', { slug: 'missing' }, api)), 'not_found');
  assert.deepEqual(calls.map((call) => call[0]), ['getSkill']);
  assert.equal(await codeOf(run('get_skill', { slug: '  ' }, api)), 'invalid_input');
});

test('get_skill cuts the text at 8192 bytes without splitting a character', async () => {
  const cases = [
    ['a'.repeat(8191) + '€' + 'b', 'a'.repeat(8191)], // the euro sign spans bytes 8191..8193
    ['a'.repeat(8189) + '€' + 'b', 'a'.repeat(8189) + '€'], // it ends exactly at the cut
    ['a'.repeat(9000), 'a'.repeat(8192)],
  ];
  for (const [text, expected] of cases) {
    const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: tar(text) }) });
    const out = await run('get_skill', { slug: 'demo' }, api);
    assert.equal(out.truncated, true);
    assert.equal(out.skill_md, expected);
    assert.ok(Buffer.byteLength(out.skill_md) <= 8192);
    assert.doesNotMatch(out.skill_md, /�/);
    assert.equal(out.content_status, 'available');
  }
  // Exactly 8192 bytes is whole, not truncated.
  const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: tar('a'.repeat(8192)) }) });
  const whole = await run('get_skill', { slug: 'demo' }, api);
  assert.equal(whole.truncated, false);
  assert.equal(whole.skill_md.length, 8192);
});

test('get_skill: an archive that expands over 16 MiB is content_unavailable', async () => {
  const bomb = tar(Buffer.alloc(17 * MIB));
  assert.ok(bomb.length < MIB, 'the fixture compresses small, so only the expansion cap can stop it');
  const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: bomb }) });
  assert.equal(await codeOf(run('get_skill', { slug: 'demo' }, api)), 'content_unavailable');
});

test('get_skill: a download over 16 MiB is content_unavailable', async () => {
  // A valid archive followed by padding: it unpacks fine, so only the size check can refuse it.
  const oversized = Buffer.concat([tar('# x'), Buffer.alloc(16 * MIB)]);
  assert.equal(unpack(oversized).length, 1, 'the fixture is a readable archive');
  assert.ok(oversized.byteLength > 16 * MIB);
  const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: oversized }) });
  assert.equal(await codeOf(run('get_skill', { slug: 'demo' }, api)), 'content_unavailable');
  const fits = Buffer.concat([tar('# x'), Buffer.alloc(16 * MIB - tar('# x').byteLength)]);
  assert.equal(fits.byteLength, 16 * MIB);
  const exact = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: fits }) });
  assert.equal((await run('get_skill', { slug: 'demo' }, exact.api)).skill_md, '# x', 'exactly 16 MiB is accepted');
});

test('get_skill: invalid UTF-8 is content_unavailable, even past the cut', async () => {
  for (const bytes of [Buffer.from([0x23, 0xff, 0x0a]), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0xc3, 0x28])])]) {
    const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: tar(bytes) }) });
    assert.equal(await codeOf(run('get_skill', { slug: 'demo' }, api)), 'content_unavailable');
  }
});

test('get_skill: a sha256 that differs from the metadata is content_unavailable', async () => {
  for (const sha256 of ['b'.repeat(64), null, undefined]) {
    const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256, tarball: tar('# x') }) });
    assert.equal(await codeOf(run('get_skill', { slug: 'demo' }, api)), 'content_unavailable', String(sha256));
  }
  const { api } = makeApi({ getSkill: async () => skillRow({ sha256: null }), download: async () => ({ sha256: null, tarball: tar('# x') }) });
  assert.equal(await codeOf(run('get_skill', { slug: 'demo' }, api)), 'content_unavailable', 'no version hash on either side');
});

test('get_skill: a 404 or 409 download gives content_status unavailable with the metadata', async () => {
  for (const status of [404, 409]) {
    const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => { throw new ApiError(status, 'x', `${CANARY} message`); } });
    const out = await run('get_skill', { slug: 'demo' }, api);
    assert.equal(out.skill_md, null);
    assert.equal(out.truncated, false);
    assert.equal(out.content_status, 'unavailable');
    assert.equal(out.slug, 'demo');
    assert.doesNotMatch(JSON.stringify(out), new RegExp(CANARY));
  }
});

test('get_skill: any other download failure propagates for the server to map', async () => {
  for (const status of [0, 401, 500]) {
    const failure = new ApiError(status, 'x', 'm');
    const { api } = makeApi({ getSkill: async () => skillRow(), download: async () => { throw failure; } });
    await assert.rejects(run('get_skill', { slug: 'demo' }, api), (error) => error === failure);
  }
});

test('get_skill returns source_url without credentials', async () => {
  const urls = ['https://user:hunter2@example.invalid/org/demo.git', 'https://hunter2@example.invalid/org/demo.git', 'https://user:hunter2@x@example.invalid/org/demo.git'];
  for (const source_url of urls) {
    const { api } = makeApi({ getSkill: async () => skillRow({ source_url }), download: async () => ({ sha256: SHA, tarball: tar('# x') }) });
    const out = await run('get_skill', { slug: 'demo' }, api);
    assert.equal(out.source_url, 'https://example.invalid/org/demo.git');
    assert.doesNotMatch(JSON.stringify(out), /hunter2|user:/);
  }
  const { api } = makeApi({ getSkill: async () => skillRow({ source_url: null }), download: async () => ({ sha256: SHA, tarball: tar('# x') }) });
  assert.equal((await run('get_skill', { slug: 'demo' }, api)).source_url, null);
});

test('stripCredentials removes only the userinfo of a URL', () => {
  const cases = [
    ['https://user:hunter2@example.invalid/a/b.git?x=1#f', 'https://example.invalid/a/b.git?x=1#f'],
    ['https://hunter2@example.invalid/a', 'https://example.invalid/a'],
    ['ssh://git@example.invalid/a.git', 'ssh://example.invalid/a.git'],
    ['https://user:hunter2@x@example.invalid/a', 'https://example.invalid/a'],
    ['https://example.invalid/a@b', 'https://example.invalid/a@b'],
    ['https://example.invalid/?mail=a@b', 'https://example.invalid/?mail=a@b'],
    ['git@example.invalid:org/repo.git', 'git@example.invalid:org/repo.git'],
    ['https://example.invalid/a', 'https://example.invalid/a'],
    ['', ''],
    // The forms a URL parser accepts although they are not the canonical `scheme://`.
    [' https://user:hunter2@example.invalid/a', 'https://example.invalid/a'],
    ['\thttps://user:hunter2@example.invalid/a \n', 'https://example.invalid/a'],
    ['https:/user:hunter2@example.invalid/x', 'https:/example.invalid/x'],
    ['https:\\\\user:hunter2@example.invalid\\a', 'https:\\\\example.invalid\\a'],
    ['https:/\\user:hunter2@example.invalid/a', 'https:/\\example.invalid/a'],
    ['https:///user:hunter2@example.invalid/a', 'https:///example.invalid/a'],
    ['//user:hunter2@example.invalid/a', '//example.invalid/a'],
    ['\\\\user:hunter2@example.invalid\\a', '\\\\example.invalid\\a'],
    // Not a URL with an authority: untouched, spaces included.
    [' git@example.invalid:org/repo.git ', ' git@example.invalid:org/repo.git '],
    ['/user@example.invalid/a', '/user@example.invalid/a'],
    ['user@example.invalid', 'user@example.invalid'],
    ['https:/example.invalid/a@b', 'https:/example.invalid/a@b'],
  ];
  for (const [input, expected] of cases) assert.equal(stripCredentials(input), expected, input);
  assert.equal(stripCredentials(null), null);
  assert.equal(stripCredentials(undefined), undefined);
});

// The two slashes of a few fixtures are spelled apart: the export's secret scan reads `://` followed by a name, a colon and an `@` as
// a credential, and these texts are fixtures, not credentials.
const SLASHES = '//';

// The forms the WHATWG parser reads as a URL with userinfo although they are not the canonical form (a scheme, two slashes, then the userinfo): it drops
// a leading C0 character or space and every tab and newline, accepts any number of slashes or none, and reads a backslash as a
// slash. The answer is the parser's view with the userinfo blanked, in the original shape when the text allows it.
const PARSED_FORMS = [
  ['https:user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['https:\t//user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['https:/\n/user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['https:/\r\n/user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u0001https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u0001 https://user:hunter2@example.invalid/x\u001f', 'https://example.invalid/x'],
  ['https://user:hunter2@exam\tple.invalid/x', 'https://example.invalid/x'],
  // The parser ends the authority at the first / ? or #: what follows is a path, a query or a fragment, never userinfo.
  ['https://us@er:12/ss@host/x', 'https://er:12/ss@host/x'],
  ['https://us@er:12?ss/x@host', 'https://er:12?ss/x@host'],
  ['https://us@er:12#ss/x@host', 'https://er:12#ss/x@host'],
  ['https://user:hunter2@example.invalid/a@b?c=d@e#f@g', 'https://example.invalid/a@b?c=d@e#f@g'],
  // The parser rejects these, so the pattern alone decides: it still removes the userinfo.
  ['https://user:hunter2@example.invalid:99999/x', 'https://example.invalid:99999/x'],
  ['https://user:hunter2@exam ple.invalid/x', 'https://exam ple.invalid/x'],
  // Unicode whitespace and invisible characters around the text are dropped as well, at either end.
  ['\u00a0https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\ufeffhttps://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u200bhttps://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u2028https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u3000https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  [' \u00a0\u200b\ufeffhttps://user:hunter2@example.invalid/x\u3000\u2029 ', 'https://example.invalid/x'],
  // Format characters (Unicode category Cf) hide a URL from a parser just as the characters above do, at either end: a soft hyphen,
  // bidirectional controls and isolates, an invisible operator, a deprecated format character, an interlinear annotation mark.
  ['\u00adhttps://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u202ahttps://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u202ehttps://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u2061https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u2066https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u206ahttps://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\ufff9https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u061chttps://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['https://user:hunter2@example.invalid/x\u202e\u00ad', 'https://example.invalid/x'],
  // Outside the Basic Multilingual Plane (the tag characters), at either end.
  ['\u{e0001}https://user:hunter2@example.invalid/x', 'https://example.invalid/x'],
  ['\u{e0020}\u{e007f}https://user:hunter2@example.invalid/x\u{e0001}', 'https://example.invalid/x'],
  ['\u{e0001}git@example.invalid:org/repo.git\u{e0001}', '\u{e0001}git@example.invalid:org/repo.git\u{e0001}'],
  ['\u{1f600}https://example.invalid/a@b', '\u{1f600}https://example.invalid/a@b'],
  [' \u00ad\u202a\u2066\ufff9https://user:hunter2@example.invalid/x\u2069\u206f ', 'https://example.invalid/x'],
  // The same characters around a text with no userinfo change nothing: the text comes back exactly as it came.
  ['\u00adgit@example.invalid:org/repo.git', '\u00adgit@example.invalid:org/repo.git'],
  ['\u202ehttps://example.invalid/a@b\u202c', '\u202ehttps://example.invalid/a@b\u202c'],
  ['\ufff9https://example.invalid/x', '\ufff9https://example.invalid/x'],
  // A slashless special scheme with a host the parser rejects: only a special scheme can be rejected without slashes, so its `@` is userinfo.
  ['http:user:hunter2@example.invalid:99999', 'http:example.invalid:99999'],
  ['http:hunter2@example.invalid:99999', 'http:example.invalid:99999'],
  ['HTTPS:user:hunter2@example.invalid:99999/x', 'HTTPS:example.invalid:99999/x'],
  // A backslash in the username: the parser ends the authority there, a reader that follows RFC 3986 does not.
  [`https:${SLASHES}a\\b:hunter2@example.invalid/x`, 'https://example.invalid/x'],
  ['https:\\\\a\\b:hunter2@example.invalid/x', 'https:\\\\example.invalid/x'],
  // Nothing to remove, in any form the parser accepts: the text comes back exactly as it came.
  ['file:///a@b', 'file:///a@b'],
  ['C:\\user@home\\x', 'C:\\user@home\\x'],
  ['//home@x/y', '//home@x/y'],
  ['\\\\home@x\\y', '\\\\home@x\\y'],
  ['mailto:user@example.invalid', 'mailto:user@example.invalid'],
  [' \thttps://example.invalid/a@b \n', ' \thttps://example.invalid/a@b \n'],
  ['\u0001git@example.invalid:org/repo.git', '\u0001git@example.invalid:org/repo.git'],
  ['\u00a0git@example.invalid:org/repo.git', '\u00a0git@example.invalid:org/repo.git'],
  ['http:example.invalid:99999', 'http:example.invalid:99999'],
  ['http://@', 'http://@'],
  ['mailto:a:b@example.invalid', 'mailto:a:b@example.invalid'],
  ['C:\\dir\\sub:x@example.invalid', 'C:\\dir\\sub:x@example.invalid'],
  ['https://example.invalid\\a@b', 'https://example.invalid\\a@b'],
  [`https:${SLASHES}example.invalid:8080\\a@b`, `https:${SLASHES}example.invalid:8080\\a@b`],
  ['https://example.invalid:8080/@user', 'https://example.invalid:8080/@user'],
  ['https://medium.example.invalid/@user/post', 'https://medium.example.invalid/@user/post'],
  // Limit: a password with a raw / ? or # cannot be told from a path. A text the parser rejects (here a "port" that is not a
  // number) is not read further, so a credential-less text of that shape stays exactly as it came.
  ['https://github.example.invalid:org/repo@v1', 'https://github.example.invalid:org/repo@v1'],
];
for (const [input, expected] of PARSED_FORMS) {
  test(`stripCredentials follows the parser: ${JSON.stringify(input)}`, () => {
    const out = stripCredentials(input);
    assert.equal(out, expected, JSON.stringify(input));
    assert.doesNotMatch(out, /hunter2/, JSON.stringify(input));
    // Whatever the parser reads in the answer carries no userinfo.
    let parsed = null;
    try { parsed = new URL(out); } catch { /* not a URL: nothing more to check */ }
    if (parsed) assert.equal(`${parsed.username}${parsed.password}`, '', JSON.stringify(input));
  });
}

// What the documents (mcp.md, server-contract.md) say stripCredentials leaves alone, pinned as they are written: a raw / ? or # in
// the password, a backslash in the password, a token-only username with a backslash, a bare scheme-less user:password@host, and
// text that holds more than one URL. The text comes back exactly as it came, which is why a server must not store credentials.
test('stripCredentials: the documented limits come back unchanged', () => {
  const limits = [
    'https://user:hunter2/x@example.invalid/y',
    'https://user:hunter2?x@example.invalid/y',
    'https://user:hunter2#x@example.invalid/y',
    'https://user:hunter2\\@example.invalid/x',
    'https://a\\hunter2@example.invalid/x',
    'user:hunter2@example.invalid',
    'see https://user:hunter2@example.invalid/x and more',
  ];
  for (const input of limits) assert.equal(stripCredentials(input), input, input);
});

// source_url is text a server chose, and stripCredentials runs synchronously inside the single MCP process: a text of any
// length must take time linear in its length, whatever it is made of. A quadratic scan took 30 s on 200k spaces.
const LONG = 200000;
const HOSTILE = {
  'spaces between two letters': () => `x${' '.repeat(LONG)}y`,
  'spaces only': () => ' '.repeat(LONG),
  'spaces around a URL': () => `${' '.repeat(LONG)}https://user:hunter2@example.invalid/x${' '.repeat(LONG)}`,
  'no-break spaces and invisible characters': () => `${'\u00a0\u200b\ufeff'.repeat(LONG / 3)}x${'\u3000'.repeat(LONG)}y`,
  'format characters': () => `${'\u00ad\u202a\u2066\ufff9'.repeat(LONG / 4)}x${'\u206a'.repeat(LONG)}y`,
  'format characters around a URL': () => `${'\u202e'.repeat(LONG)}https://user:hunter2@example.invalid/x${'\u00ad'.repeat(LONG)}`,
  'control characters': () => `\u0001${'\t\n '.repeat(LONG / 3)}x`,
  'at signs after a scheme': () => `https://${'@'.repeat(LONG)}`,
  'at signs and colons in the authority': () => `https://${'a:@'.repeat(LONG / 3)}host`,
  'colons': () => `https:${':'.repeat(LONG)}`,
  'colons after slashes': () => `//${':'.repeat(LONG)}`,
  'backslashes': () => `https:${SLASHES}${'\\'.repeat(LONG)}x:y@z`,
  'backslashes and colons': () => `https:\\\\${'a\\:'.repeat(LONG / 3)}@h`,
  'slashes': () => `https:${'/'.repeat(LONG)}@`,
  'slashes, no scheme': () => `${'/'.repeat(LONG)}x:y@`,
  'scheme characters': () => `${'a'.repeat(LONG)}`,
  'scheme characters with a colon': () => `${'a'.repeat(LONG)}:x@y`,
  'a long userinfo': () => `https:${SLASHES}${'u'.repeat(LONG)}:${'p'.repeat(LONG)}@example.invalid/x`,
  'a long path with at signs': () => `https://example.invalid/${'@'.repeat(LONG)}`,
};
for (const [label, make] of Object.entries(HOSTILE)) {
  test(`stripCredentials takes linear time: ${label}`, () => {
    const input = make();
    const started = performance.now();
    const out = stripCredentials(input);
    const elapsed = performance.now() - started;
    assert.equal(typeof out, 'string');
    assert.ok(elapsed < 1000, `${label}: ${Math.round(elapsed)} ms for ${input.length} characters`);
  });
}

// ---- readSkillContent ----

test('readSkillContent: a plugin, or no tarball, is unavailable without reading anything', () => {
  const unavailable = { skill_md: null, truncated: false, content_status: 'unavailable' };
  assert.deepEqual(readSkillContent({ kind: 'plugin' }, tar('# x')), unavailable);
  assert.deepEqual(readSkillContent({ kind: 'skill', plugin_slug: 'p' }, tar('# x')), unavailable);
  assert.deepEqual(readSkillContent({ kind: 'skill', plugin_slug: null }, null), unavailable);
  assert.deepEqual(readSkillContent({ kind: 'skill' }, undefined), unavailable);
});

test('readSkillContent: only the root SKILL.md counts', () => {
  const row = { kind: 'skill', plugin_slug: null };
  assert.deepEqual(readSkillContent(row, archive({ 'SKILL.md': '# root', 'sub/SKILL.md': '# nested' })), { skill_md: '# root', truncated: false, content_status: 'available' });
  assert.deepEqual(readSkillContent(row, archive({ 'sub/SKILL.md': '# nested', 'README.md': '# r' })), { skill_md: null, truncated: false, content_status: 'unavailable' });
});

test('readSkillContent: a damaged or foreign tarball throws content_unavailable with a fixed message', () => {
  const row = { kind: 'skill', plugin_slug: null };
  for (const tarball of [Buffer.from('not a gzip'), new Uint8Array(0), 'text', {}, Buffer.from(tar('# x')).subarray(0, 20)]) {
    assert.throws(() => readSkillContent(row, tarball), (error) => error.code === 'content_unavailable' && error.message === 'content_unavailable');
  }
});

// ---- list_my_skills ----

const listRow = (i, extra = {}) => ({ slug: `s${i}`, name: `Skill ${i}`, description: `desc ${i}`, kind: 'skill', plugin_slug: null, tags: ['a'], quality: 0.5, update_available: 0, has_approved_version: 1, ...extra });
const listing = (total) => async ({ limit, offset }) => ({
  skills: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => listRow(offset + i)),
  total, limit, offset,
});

test('list_my_skills: the first page of 50, its shape and the next cursor', async () => {
  const { api, calls } = makeApi({ list: listing(120) });
  const out = await run('list_my_skills', {}, api);
  assert.deepEqual(calls, [['list', { kind: undefined, tag: undefined, limit: 50, offset: 0 }]]);
  assert.equal(out.skills.length, 50);
  assert.deepEqual(out.skills[0], { slug: 's0', name: 'Skill 0', kind: 'skill', tags: ['a'], update_available: false, description: 'desc 0' });
  assert.equal(typeof out.next_cursor, 'string');
  assert.deepEqual(Object.keys(out).sort(), ['next_cursor', 'skills']);
});

test('list_my_skills: the cursor continues where the page ended, and the last page has none', async () => {
  const { api, calls } = makeApi({ list: listing(120) });
  const first = await run('list_my_skills', { kind: 'skill', tag: 't' }, api);
  const second = await run('list_my_skills', { kind: 'skill', tag: 't', cursor: first.next_cursor }, api);
  assert.equal(calls[1][1].offset, 50);
  assert.deepEqual(calls[1][1], { kind: 'skill', tag: 't', limit: 50, offset: 50 });
  assert.equal(second.skills[0].slug, 's50');
  assert.equal(second.skills.length, 50);
  const third = await run('list_my_skills', { kind: 'skill', tag: 't', cursor: second.next_cursor }, api);
  assert.deepEqual(third.skills.map((s) => s.slug), Array.from({ length: 20 }, (_, i) => `s${100 + i}`));
  assert.equal(third.next_cursor, null);
});

test('list_my_skills: a catalog of exactly 50, an empty one and a cursor past the end have no next page', async () => {
  const exact = makeApi({ list: listing(50) });
  const page = await run('list_my_skills', {}, exact.api);
  assert.equal(page.skills.length, 50);
  assert.equal(page.next_cursor, null);
  const empty = makeApi({ list: listing(0) });
  assert.deepEqual(await run('list_my_skills', {}, empty.api), { skills: [], next_cursor: null });
  const past = makeApi({ list: listing(10) });
  assert.deepEqual(await run('list_my_skills', { cursor: '500' }, past.api), { skills: [], next_cursor: null });
});

test('list_my_skills: an empty page never hands back a cursor, whatever total says', async () => {
  // A server that answers no skills but a positive total would otherwise loop a client on the same cursor forever.
  const { api } = makeApi({ list: async () => ({ skills: [], total: 5 }) });
  assert.deepEqual(await run('list_my_skills', { cursor: '0' }, api), { skills: [], next_cursor: null });
  assert.deepEqual(await run('list_my_skills', {}, api), { skills: [], next_cursor: null });
  assert.deepEqual(await run('list_my_skills', { cursor: '3' }, api), { skills: [], next_cursor: null });
  const short = makeApi({ list: async () => ({ skills: [listRow(0), listRow(1)], total: 9 }) });
  assert.equal((await run('list_my_skills', { cursor: '3' }, short.api)).next_cursor, '5', 'a non-empty page still advances');
});

test('list_my_skills: an invalid cursor is invalid_input and reaches no api call', async () => {
  const { api, calls } = makeApi({ list: listing(120) });
  for (const cursor of ['abc', '-1', '1.5', '01', '1e3', ' 5', '5 ', '', '12345678901', '0x10', '５０', null, 50]) {
    assert.equal(await codeOf(run('list_my_skills', { cursor }, api)), 'invalid_input', String(cursor));
  }
  assert.deepEqual(calls, []);
});

test('list_my_skills: the description is cut at 100 characters on a word boundary and the tags at 3', async () => {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
  assert.ok(words.length > 100);
  const rows = [
    listRow(0, { description: words, tags: ['1', '2', '3', '4', '5'] }),
    listRow(1, { description: 'x'.repeat(150) }),
    listRow(2, { description: 'y'.repeat(100) }),
    listRow(3, { description: '😀'.repeat(100) }),
    listRow(4, { description: '😀'.repeat(101) }),
  ];
  const { api } = makeApi({ list: async () => ({ skills: rows, total: rows.length }) });
  const { skills } = await run('list_my_skills', {}, api);
  assert.deepEqual(skills[0].tags, ['1', '2', '3']);
  assert.ok(skills[0].description.endsWith('…'));
  assert.ok([...skills[0].description].length <= 100);
  assert.ok(words.startsWith(skills[0].description.slice(0, -1)), 'a prefix of the original');
  assert.match(words.slice(skills[0].description.length - 1), /^ /, 'the cut falls on a word boundary');
  assert.equal(skills[1].description, `${'x'.repeat(99)}…`, 'a word longer than the head is cut hard');
  assert.equal(skills[2].description, 'y'.repeat(100), 'exactly 100 characters stays whole');
  assert.equal(skills[3].description, '😀'.repeat(100));
  assert.equal(skills[4].description, `${'😀'.repeat(99)}…`, 'characters, not UTF-16 units, are counted');
  assert.ok(!JSON.stringify(skills).includes('quality'));
});

// descriptionHead keeps the first 99 characters, cuts at the last space when it falls after index 50, and trims the end.
test('list_my_skills: the word-boundary cut applies only when the last space is after index 50', async () => {
  const described = async (description) => {
    const { api } = makeApi({ list: async () => ({ skills: [listRow(0, { description })], total: 1 }) });
    return (await run('list_my_skills', {}, api)).skills[0].description;
  };
  // A space at index 50 is too early to be a boundary: the head is kept whole.
  assert.equal(await described(`${'a'.repeat(50)} ${'b'.repeat(80)}`), `${'a'.repeat(50)} ${'b'.repeat(48)}…`);
  // A space at index 51 is a boundary.
  assert.equal(await described(`${'a'.repeat(51)} ${'b'.repeat(80)}`), `${'a'.repeat(51)}…`);
  // The last space of the head (index 98) is a boundary, and the word after it is dropped.
  assert.equal(await described(`${'a'.repeat(98)} ${'b'.repeat(10)}`), `${'a'.repeat(98)}…`);
  // Only the last space counts.
  assert.equal(await described(`${'a'.repeat(10)} ${'b'.repeat(60)} ${'c'.repeat(60)}`), `${'a'.repeat(10)} ${'b'.repeat(60)}…`);
});

test('list_my_skills: the text before the ellipsis never ends with whitespace', async () => {
  const described = async (description) => {
    const { api } = makeApi({ list: async () => ({ skills: [listRow(0, { description })], total: 1 }) });
    return (await run('list_my_skills', {}, api)).skills[0].description;
  };
  assert.equal(await described(`${'a'.repeat(60)}  ${'b'.repeat(60)}`), `${'a'.repeat(60)}…`, 'a double space at the cut');
  assert.equal(await described(`${'a'.repeat(98)}\n${'b'.repeat(10)}`), `${'a'.repeat(98)}…`, 'a newline ends the head');
  assert.equal(await described(`${'a'.repeat(97)}\t\t${'b'.repeat(10)}`), `${'a'.repeat(97)}…`, 'tabs end the head');
});

// ---- install_command ----

test('install_command: the command for a skill, with every value quoted', async () => {
  const { api, calls } = makeApi({ getSkill: async () => skillRow() });
  const out = await run('install_command', { slug: 'demo', harness: 'codex' }, api);
  assert.deepEqual(calls, [['getSkill', 'demo']]);
  assert.deepEqual(out, { command: "headjack add --to 'codex' --session -- 'demo'", reload_plugins: false });
});

test('install_command: the quoted slug reaches the CLI as one argument, whatever it holds', async () => {
  for (const slug of ["'; touch x; $(id) `id`", "it's", '--force', 'a b\nc']) {
    const { api } = makeApi({ getSkill: async () => skillRow({ slug }) });
    const { command } = await run('install_command', { slug, harness: 'claude' }, api);
    const dir = mkdtempSync(path.join(tmpdir(), 'headjack-quote-'));
    try {
      const script = `headjack() { for a in "$@"; do printf '[%s]' "$a"; done; }; ${command}`;
      const printed = execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' });
      assert.equal(printed, `[add][--to][claude][--session][--][${slug}]`);
      assert.equal(existsSync(path.join(dir, 'x')), false, 'no injected command ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('shellQuote: sh prints a hostile value back unchanged', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'headjack-quote-'));
  try {
    for (const value of ["'; touch x; $(id) `id`", "it's a 'quoted' value", '--help', '-n', '', '$HOME "q" \\ * ?', 'line1\nline2']) {
      const printed = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], { cwd: dir, encoding: 'utf8' });
      assert.equal(printed, value, JSON.stringify(value));
    }
    assert.equal(existsSync(path.join(dir, 'x')), false, 'the injected touch never ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install_command: a plugin allows only claude and asks for a reload', async () => {
  for (const extra of [{ kind: 'plugin' }, { plugin_slug: 'p' }]) {
    const { api } = makeApi({ getSkill: async () => skillRow(extra) });
    assert.equal(await codeOf(run('install_command', { slug: 'demo', harness: 'codex' }, api)), 'unsupported_harness');
    assert.deepEqual(await run('install_command', { slug: 'demo', harness: 'claude' }, api), { command: "headjack add --to 'claude' --session -- 'demo'", reload_plugins: true });
  }
});

test('install_command: an unknown harness is invalid_input, before any lookup', async () => {
  const { api, calls } = makeApi({ getSkill: async () => skillRow() });
  for (const harness of ['nope', '', 'CLAUDE', 'constructor', '__proto__', undefined, 5]) {
    assert.equal(await codeOf(run('install_command', { slug: 'demo', harness }, api)), 'invalid_input', String(harness));
  }
  assert.equal(await codeOf(run('install_command', { slug: ' ', harness: 'claude' }, api)), 'invalid_input');
  assert.deepEqual(calls, []);
});

test('install_command: an unknown slug is not_found', async () => {
  const { api } = makeApi({ getSkill: async () => null });
  assert.equal(await codeOf(run('install_command', { slug: 'missing', harness: 'claude' }, api)), 'not_found');
});

// ---- input that the REST layer would read differently ----

// The REST layer splits a tag filter on commas and drops the blank items, so `,` or `  ` would become no filter at all and return
// the whole catalog: the tools refuse such a tag themselves.
test('search_skills and list_my_skills: a tag with a comma, or only blanks, is invalid_input before any request', async () => {
  const { api, calls } = makeApi({ search: async () => [], list: async () => ({ skills: [], total: 0 }) });
  for (const tag of [',', 'a,b', ',a', 'a,', ' ', '  ', '\n', ' ']) {
    assert.equal(await codeOf(run('list_my_skills', { tag }, api)), 'invalid_input', JSON.stringify(tag));
    assert.equal(await codeOf(run('search_skills', { query: 'q', tags: ['ok', tag] }, api)), 'invalid_input', JSON.stringify(tag));
  }
  assert.deepEqual(calls, []);
  await run('list_my_skills', { tag: 'a-b' }, api);
  await run('search_skills', { query: 'q', tags: ['a-b', 'c'] }, api);
  assert.equal(calls.length, 2, 'an ordinary tag still reaches the api');
});

// `.` and `..` survive encodeURIComponent, so a request for them would climb out of /api/skills/ once the URL is resolved.
test('get_skill and install_command: the slugs . and .. are invalid_input before any request', async () => {
  const { api, calls } = makeApi({ getSkill: async () => skillRow(), download: async () => ({ sha256: SHA, tarball: tar('# x') }) });
  for (const slug of ['.', '..']) {
    assert.equal(await codeOf(run('get_skill', { slug }, api)), 'invalid_input', slug);
    assert.equal(await codeOf(run('install_command', { slug, harness: 'claude' }, api)), 'invalid_input', slug);
  }
  assert.deepEqual(calls, []);
  for (const slug of ['.a', 'a.', '..a', 'a..', 'a.b', '...']) {
    assert.equal((await run('install_command', { slug, harness: 'claude' }, api)).reload_plugins, false, slug);
  }
  assert.equal(calls.length, 6, 'a slug that merely contains dots still reaches the api');
});

// ---- the real api client against a loopback server ----

async function loopback(onRequest) {
  const sockets = new Set();
  const server = http.createServer(onRequest);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}
const realApi = (url) => createApi({ url, credential: { kind: 'api-key', token: 'key', source: 'env' }, env: {} });
const settle = (predicate, ms = 3000) => new Promise((resolve) => {
  const started = Date.now();
  const tick = () => (predicate() || Date.now() - started > ms ? resolve(predicate()) : setTimeout(tick, 10));
  tick();
});

test('through the real client: a body reset after the headers is unavailable, never internal', async () => {
  const origin = await loopback((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100000' });
    res.write('{"results":[');
    setTimeout(() => res.socket.destroy(), 30);
  });
  try {
    const call = serverFor(realApi(origin.url));
    const search = await call('search_skills', { query: 'q' });
    assert.equal(search.text, JSON.stringify({ error: { code: 'unavailable' } }));
    const list = await call('list_my_skills', {});
    assert.equal(list.text, JSON.stringify({ error: { code: 'unavailable' } }));
  } finally {
    await origin.stop();
  }
});

// A download is refused as soon as it is known to pass the cap: by its length when it declares one, else as the bytes arrive.
async function skillOrigin(downloadHandler) {
  const record = skillRow();
  const seen = { written: 0, closed: false };
  const origin = await loopback((req, res) => {
    if (req.url === '/api/skills/demo') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ skill: record }));
    } else if (req.url === '/api/skills/demo/download') {
      downloadHandler(req, res, seen);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    }
  });
  return { ...origin, seen };
}

test('through the real client: a download that declares more than 16 MiB is content_unavailable without reading it', async () => {
  const origin = await skillOrigin((req, res, seen) => {
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(64 * MIB), 'x-skill-sha256': SHA });
    res.on('close', () => { seen.closed = true; });
    res.write(Buffer.alloc(1024));
  });
  try {
    const result = await serverFor(realApi(origin.url))('get_skill', { slug: 'demo' });
    assert.equal(result.text, JSON.stringify({ error: { code: 'content_unavailable' } }));
    assert.equal(await settle(() => origin.seen.closed), true, 'the client dropped the connection');
  } finally {
    await origin.stop();
  }
});

test('through the real client: a chunked download past 16 MiB stops being read and is content_unavailable', async () => {
  const origin = await skillOrigin((req, res, seen) => {
    res.writeHead(200, { 'content-type': 'application/gzip', 'x-skill-sha256': SHA });
    res.on('close', () => { seen.closed = true; });
    const chunk = Buffer.alloc(MIB);
    const pump = () => {
      while (!seen.closed && seen.written < 200 * MIB) {
        seen.written += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  try {
    const result = await serverFor(realApi(origin.url))('get_skill', { slug: 'demo' });
    assert.equal(result.text, JSON.stringify({ error: { code: 'content_unavailable' } }));
    assert.equal(await settle(() => origin.seen.closed), true, 'the client dropped the connection');
    assert.ok(origin.seen.written < 96 * MIB, `the server was stopped after ${origin.seen.written} bytes`);
  } finally {
    await origin.stop();
  }
});

// ---- through the server: a fixed code and nothing else ----

function serverFor(api, mode = 'hosted') {
  const server = createMcpServer({ tools, openApi: async () => ({ api, close: () => {} }), version: '0.0.0', mode });
  return async (name, args) => {
    const reply = JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })));
    return { text: reply.result.content[0].text, isError: reply.result.isError, body: JSON.parse(reply.result.content[0].text) };
  };
}

test('through the server: every failure is a fixed code, never an api message', async () => {
  const leak = (status) => new ApiError(status, `${CANARY}_code`, `${CANARY} message with /private/${CANARY}/path`);
  const cases = [
    ['get_skill', { slug: 'demo' }, { getSkill: async () => { throw leak(500); } }, 'unavailable'],
    ['get_skill', { slug: 'demo' }, { getSkill: async () => { throw leak(401); } }, 'unauthenticated'],
    ['get_skill', { slug: 'demo' }, { getSkill: async () => skillRow(), download: async () => { throw leak(403); } }, 'forbidden'],
    ['get_skill', { slug: 'demo' }, { getSkill: async () => skillRow(), download: async () => { throw new Error(`${CANARY} boom`); } }, 'internal'],
    ['get_skill', { slug: 'demo' }, { getSkill: async () => null }, 'not_found'],
    ['get_skill', { slug: 'demo' }, { getSkill: async () => skillRow(), download: async () => ({ sha256: 'b'.repeat(64), tarball: tar('# x') }) }, 'content_unavailable'],
    ['search_skills', { query: 'q' }, { search: async () => { throw leak(429); } }, 'rate_limited'],
    ['list_my_skills', {}, { list: async () => { throw leak(400); } }, 'bad_request'],
    ['list_my_skills', { cursor: 'abc' }, {}, 'invalid_input'],
    ['install_command', { slug: 'demo', harness: 'nope' }, {}, 'invalid_input'],
    ['install_command', { slug: 'demo', harness: 'codex' }, { getSkill: async () => skillRow({ kind: 'plugin' }) }, 'unsupported_harness'],
  ];
  for (const [name, args, methods, code] of cases) {
    const { api } = makeApi(methods);
    const result = await serverFor(api)(name, args);
    assert.equal(result.isError, true, `${name} ${code}`);
    assert.equal(result.text, JSON.stringify({ error: { code } }), `${name} ${code}`);
    assert.doesNotMatch(result.text, new RegExp(CANARY));
  }
});

test('through the server: a success is one JSON text with the documented shape', async () => {
  const { api } = makeApi({
    search: async () => [{ slug: 'a', kind: 'skill', description: 'd', tags: [], quality: 1, update_available: false }],
    getSkill: async () => skillRow(),
    download: async () => ({ sha256: SHA, tarball: tar('# Demo') }),
    list: listing(3),
  });
  const call = serverFor(api);
  const search = await call('search_skills', { query: 'q' });
  assert.equal(search.isError, false);
  assert.deepEqual(search.body, { results: [{ slug: 'a', kind: 'skill', description: 'd', tags: [], update_available: false }] });
  const skill = await call('get_skill', { slug: 'demo' });
  assert.equal(skill.body.skill_md, '# Demo');
  assert.equal(skill.body.content_status, 'available');
  assert.equal((await call('list_my_skills', {})).body.skills.length, 3);
  assert.equal((await call('install_command', { slug: 'demo', harness: 'claude' })).body.command, "headjack add --to 'claude' --session -- 'demo'");
});
