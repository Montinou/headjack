// The two contract documents, docs/server-contract.md and the MCP guide (docs/mcp.md), are checked against the client sources
// they describe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { file, tempDir } from '../helpers.mjs';
import { createLocalApi } from '../../lib/local/api.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { pack } from '../../lib/tar.mjs';
import { createTools } from '../../cli/mcp-tools.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const contract = read('docs/server-contract.md');
const guide = read('docs/mcp.md');

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD';
const SEGMENT = /\$\{[^}]*\}/g;

// Every `METHOD path` pair a client source calls, as the contract spells it: `{slug}` for the slug segment, no query string.
// A path literal is a /api/... or /.well-known/... string. A discovery document is a GET; an /api/ call is a POST when the text
// up to the next such literal (at most WINDOW characters) holds `method: 'POST'`, else a GET.
const WINDOW = 400;
function calledRoutes(source) {
  const literal = /(\/(?:api|\.well-known)\/[^`'"\s?]*)/g;
  const found = [...source.matchAll(literal)].filter((m) => !/^\s*\/\//.test(source.slice(source.lastIndexOf('\n', m.index) + 1, m.index)));
  return found.map((m, i) => {
    // A template expression that is not the slug (`${grandfathered ? ... }`) belongs to the query string: it ends the path.
    const route = m[1].replace(SEGMENT, '{slug}').replace(/\$\{.*$/, '');
    if (route.startsWith('/.well-known/')) return `GET ${route}`;
    const window = source.slice(m.index, Math.min(found[i + 1]?.index ?? source.length, m.index + WINDOW));
    return `${/method:\s*'POST'/.test(window) ? 'POST' : 'GET'} ${route}`;
  });
}

// The `METHOD path` tokens a document writes (query strings dropped), as exact pairs.
function documentedRoutes(text) {
  const tokens = text.matchAll(new RegExp(`\\b(${METHODS}) (/[^\\s\`|)?,;:*]*)`, 'g'));
  return new Set([...tokens].map((m) => `${m[1]} ${m[2].replace(/\.+$/, '')}`));
}

// The text of the section titled `title` (a heading of level 2 to 4), up to the next heading.
function sectionOf(text, title) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^#{2,4} /.test(line) && line.replace(/^#+ /, '').trim() === title);
  assert.notEqual(start, -1, `a section titled ${title}`);
  const end = lines.findIndex((line, i) => i > start && /^#{2,4} /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// The rows of the first Markdown table in `text` whose header line matches `header`: { cells: [first cell, ...] }.
function tableRows(text, header) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => header.test(line));
  assert.notEqual(start, -1, `a table with the header ${header}`);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    rows.push({ cells: lines[i].slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()) });
  }
  assert.ok(rows.length > 0, 'the table has rows');
  return rows;
}

// The names written as code in a table cell: `slug`, `name` gives both.
const names = (cell) => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);

const clientRoutes = [...new Set(['cli/api.mjs', 'cli/oauth.mjs', 'cli/login.mjs'].flatMap((source) => calledRoutes(read(source))))].sort();

test('the extractor reads the client: every route it is known to call is found', () => {
  for (const expected of [
    'GET /api/search', 'GET /api/skills', 'GET /api/skills/{slug}', 'GET /api/skills/{slug}/download',
    'GET /api/skills/{slug}/versions', 'GET /api/skills/{slug}/reviews', 'POST /api/skills', 'GET /api/updates',
    'POST /api/search', 'POST /api/events/install', 'GET /.well-known/oauth-protected-resource/api',
    'GET /.well-known/oauth-authorization-server', 'GET /.well-known/openid-configuration',
  ]) assert.ok(clientRoutes.includes(expected), `${expected} is extracted from the client sources`);
  assert.equal(clientRoutes.length, 13, `exactly the routes above, got ${clientRoutes.join(', ')}`);
});

test('server-contract.md: every METHOD path the client calls is written as that exact pair', () => {
  const documented = documentedRoutes(contract);
  assert.deepEqual(clientRoutes.filter((route) => !documented.has(route)), []);
});

test('server-contract.md: every route has a section of its own, titled with the pair', () => {
  const headings = new Set([...contract.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].trim()));
  assert.deepEqual(clientRoutes.filter((route) => !headings.has(route)), []);
});

test('a documented route must be a pair, not a prefix: GET /api/skills is not satisfied by GET /api/skills/{slug}', () => {
  const only = documentedRoutes('GET /api/skills/{slug} and `POST /api/skills`');
  assert.equal(only.has('GET /api/skills'), false);
  assert.equal(only.has('GET /api/skills/{slug}'), true);
  assert.equal(only.has('POST /api/skills'), true);
});

test('server-contract.md: every header the client sends or reads, and the credential, the error body and the scopes', () => {
  const api = read('cli/api.mjs');
  const headers = [...new Set([...api.matchAll(/['"`](x-[a-z0-9-]+)['"`]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(headers, ['x-headjack-purpose', 'x-headjack-session', 'x-skill-sha256']);
  for (const header of [...headers, 'Authorization', 'Bearer']) assert.ok(contract.includes(header), `mentions ${header}`);
  for (const needle of ['"error"', '"code"', '"message"', 'skills:read', 'skills:write', 'content-type']) {
    assert.ok(contract.toLowerCase().includes(needle.toLowerCase()), `mentions ${needle}`);
  }
});

test('server-contract.md: the sha256 pairing, the list route parameters, the purposes and the optional OAuth login', () => {
  const flat = contract.replace(/\s+/g, ' ');
  assert.match(flat, /x-skill-sha256[^.]*`sha256`|`sha256`[^.]*x-skill-sha256/, 'the header and the metadata field are tied together');
  assert.match(flat, /content_unavailable/);
  for (const name of ['kind', 'tag', 'limit', 'offset', 'total']) assert.ok(contract.includes(`\`${name}\``), `list route: ${name}`);
  assert.match(flat, /100/, 'the largest page');
  for (const purpose of ['suggest', 'plan', 'manual', 'eval', 'warmup']) assert.ok(contract.includes(`\`${purpose}\``), `purpose ${purpose}`);
  for (const needle of ['headjack_cli_client_id', 'authorization_servers', 'S256', 'userinfo', 'email', 'issuer', 'revocation', 'resource']) {
    assert.ok(contract.includes(needle), `OAuth: ${needle}`);
  }
  assert.match(flat, /404[^.]*(not enabled|login)/i, 'a 404 from the resource document means the login is not enabled');
});

test('mcp.md: every tool, every error code, the three protocol versions, the timeout variable and an env block', () => {
  const source = read('cli/mcp.mjs');
  const codes = [...source.match(/const ERROR_CODES = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(codes, [
    'invalid_input', 'bad_request', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'rate_limited', 'unavailable',
    'vault_damaged', 'unsupported_harness', 'content_unavailable', 'internal',
  ]);
  const versions = [
    ...source.match(/const PROTOCOLS = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'(\d{4}-\d\d-\d\d)'/g),
    ...source.matchAll(/const LATEST_PROTOCOL = '(\d{4}-\d\d-\d\d)'/g),
  ].map((m) => m[1]);
  assert.deepEqual(versions, ['2024-11-05', '2025-03-26', '2025-06-18']);
  for (const tool of createTools()) assert.ok(guide.includes(`\`${tool.name}\``), `tool ${tool.name}`);
  for (const code of codes) assert.ok(guide.includes(`\`${code}\``), `error code ${code}`);
  for (const version of versions) assert.ok(guide.includes(version), `protocol ${version}`);
  assert.ok(guide.includes('HEADJACK_MCP_TIMEOUT_MS'));
  assert.match(guide, /"env"\s*:\s*\{[^}]*"HEADJACK_URL"\s*:/, 'a JSON env block with HEADJACK_URL');
  assert.match(guide, /"command"\s*:/, 'a registration example with a command');
});

test('mcp.md: the limits, the rulings on content and cursors, and the login advice', () => {
  const flat = guide.replace(/\s+/g, ' ');
  for (const needle of ['8192', '16 MiB', '1 MiB', '30 s', '50', '300', '256', 'batch', 'newline-delimited', 'stdio', '-32700', '-32600', '-32601', 'headjack login']) {
    assert.ok(flat.includes(needle), `mentions ${needle}`);
  }
  assert.match(flat, /content_status[^.]*`available`|`available`[^.]*content_status/);
  assert.match(flat, /`unavailable`/);
  assert.match(flat, /x-skill-sha256/);
  assert.match(flat, /opaque/i);
  assert.match(flat, /`source_url`[^.]*(credential|user)/i);
  assert.match(flat, /untrusted/i);
  assert.match(flat, /unauthenticated[^.]*headjack login|headjack login[^.]*unauthenticated/);
  assert.match(flat, /list_my_skills[^.]*`GET \/api\/skills`|`GET \/api\/skills`[^.]*list_my_skills/);
});

test('the documents say exactly what the code does: credentials, cursors, hash order, request bodies, error and mode wording', () => {
  const flatContract = contract.replace(/\s+/g, ' ');
  const flatGuide = guide.replace(/\s+/g, ' ');
  // source_url: the userinfo of a URL it can parse is removed, a server must not store credentials there, and nothing more is promised.
  for (const [name, text] of [['server-contract.md', flatContract], ['mcp.md', flatGuide]]) {
    assert.match(text, /user:password@/, `${name}: names the part that is removed`);
    assert.match(text, /must not store credentials/, `${name}: tells a server not to store credentials`);
    assert.doesNotMatch(text, /whatever the server stored|any `user:password@` part/, `${name}: no claim wider than the code`);
  }
  // A cursor is any canonical number (cli/mcp-tools.mjs), not only one the server handed out.
  assert.doesNotMatch(flatGuide, /did not hand out|not one the server handed out/);
  assert.match(flatGuide, /canonical number/);
  // The hash order is the one of lib/hash.mjs (a string comparison), and the form-encoded bodies are not JSON.
  assert.match(readFileSync(path.join(ROOT, 'lib/hash.mjs'), 'utf8'), /a < b \? -1 : a > b \? 1 : 0/, 'comparePaths is a plain string comparison');
  assert.match(flatContract, /UTF-16 code-unit order/);
  assert.doesNotMatch(flatContract, /\(byte order\)/);
  assert.match(flatContract, /except the multipart form of `POST \/api\/skills` and the `application\/x-www-form-urlencoded` bodies/);
  assert.ok(read('cli/oauth.mjs').includes('application/x-www-form-urlencoded'), 'the client does send form-encoded bodies');
  // The guide does not promise "never changes anything", and a public reader is not pointed at a server they cannot see.
  assert.doesNotMatch(flatGuide, /never changes anything/);
  assert.match(flatGuide, /changes nothing in the catalog/);
  assert.doesNotMatch(flatContract, /reference server/i);
  assert.doesNotMatch(flatContract, /maintainer's repository/);
  // In hosted mode a client problem (a bad HEADJACK_URL included) is unauthenticated: the two rows say so (cli/mcp.mjs mapError).
  assert.match(read('cli/mcp.mjs'), /instanceof UserError\) return mode === 'hosted' \? 'unauthenticated' : 'unavailable'/);
  const unavailableRow = flatGuide.match(/\| `unavailable` \|([^|]*)\|/)[1];
  const unauthenticatedRow = flatGuide.match(/\| `unauthenticated` \|([^|]*)\|/)[1];
  assert.match(unauthenticatedRow, /HEADJACK_URL/);
  assert.doesNotMatch(unavailableRow, /HEADJACK_URL/);
  assert.match(unavailableRow, /hosted mode[^.]*unauthenticated/);
});

// The documents name the fields the code really returns: a vault is filled with one skill and the answers are read back.
localTest('the documented fields are the ones the handlers and the tools return', async () => {
  const dir = await tempDir('hj-contract-');
  const files = [file('SKILL.md', '---\nname: contract-demo\ndescription: A skill for the contract test\n---\n# Demo')];
  const { api, close } = await createLocalApi({ dir });
  try {
    await api.publish({
      slug: 'contract-demo', name: 'contract-demo', description: 'A skill for the contract test', kind: 'skill', tags: ['demo'],
      source: { kind: 'local' }, sha256: hashFiles(files), status: 'approved', review_notes: 'ok', scan_flags: [], chunks: ['contract-demo: demo'],
    }, pack(files));
    // A field is documented when the section of its own response names it as code (`name`) or as a JSON key ("name"): a name that
    // is written elsewhere in the document (another route, a sentence about something else) does not count. The skill record
    // table is part of every section that says "as in the skill record".
    const documented = (text, name) => text.includes(`\`${name}\``) || text.includes(`"${name}"`);
    const recordTable = tableRows(contract, /^\| Field \| Type \| Meaning \|$/m);
    const recordText = recordTable.map((row) => row.cells[0]).join(' ');

    const row = await api.getSkill('contract-demo');
    for (const name of Object.keys(row)) assert.ok(documented(recordText, name), `server-contract.md: skill record table lists ${name}`);
    // The other way round: the table lists no field that the record never carries.
    assert.deepEqual(recordTable.flatMap((r) => names(r.cells[0])).filter((name) => !(name in row)), [], 'server-contract.md: fields only the document has');

    const listed = (await api.list({})).skills[0];
    const listSection = sectionOf(contract, 'GET /api/skills');
    for (const name of Object.keys(listed)) assert.ok(documented(`${listSection} ${recordText}`, name), `server-contract.md: list field ${name}`);

    const found = (await api.search('demo'))[0];
    const searchSection = sectionOf(contract, 'GET /api/search');
    for (const name of Object.keys(found)) assert.ok(documented(`${searchSection} ${recordText}`, name), `server-contract.md: search field ${name}`);

    const versions = (await api.versions('contract-demo'))[0];
    const versionsSection = sectionOf(contract, 'GET /api/skills/{slug}/versions');
    for (const name of Object.keys(versions)) assert.ok(documented(versionsSection, name), `server-contract.md: version field ${name}`);

    const review = (await api.reviews('contract-demo'))[0];
    const reviewsSection = sectionOf(contract, 'GET /api/skills/{slug}/reviews');
    for (const name of Object.keys(review)) assert.ok(documented(reviewsSection, name), `server-contract.md: review field ${name}`);

    const toolOut = await createTools().find((t) => t.name === 'get_skill').handler({ slug: 'contract-demo' }, { api });
    const getTable = tableRows(sectionOf(guide, '`get_skill`'), /^\| Field \| Meaning \|$/m);
    for (const name of Object.keys(toolOut)) assert.ok(documented(getTable.map((r) => r.cells[0]).join(' '), name), `mcp.md: get_skill table lists ${name}`);
    assert.deepEqual(getTable.flatMap((r) => names(r.cells[0])).filter((name) => !(name in toolOut)), [], 'mcp.md: get_skill fields only the document has');

    const fromList = await createTools().find((t) => t.name === 'list_my_skills').handler({}, { api });
    const listTool = sectionOf(guide, '`list_my_skills`');
    for (const name of [...Object.keys(fromList), ...Object.keys(fromList.skills[0])]) assert.ok(documented(listTool, name), `mcp.md: list_my_skills field ${name}`);
    const fromSearch = await createTools().find((t) => t.name === 'search_skills').handler({ query: 'demo' }, { api });
    const searchTool = sectionOf(guide, '`search_skills`');
    for (const name of [...Object.keys(fromSearch), ...Object.keys(fromSearch.results[0])]) assert.ok(documented(searchTool, name), `mcp.md: search_skills field ${name}`);
    const command = await createTools().find((t) => t.name === 'install_command').handler({ slug: 'contract-demo', harness: 'claude' }, { api });
    const installTool = sectionOf(guide, '`install_command`');
    for (const name of Object.keys(command)) assert.ok(documented(installTool, name), `mcp.md: install_command field ${name}`);
  } finally {
    close();
  }
});
