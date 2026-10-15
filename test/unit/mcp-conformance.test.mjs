// Conformance of the local MCP server (cli/mcp.mjs) to the reference client: the official MCP client package drives it over
// stdio. The hand-written protocol is only as good as its agreement with that client, which also validates every result
// against the protocol schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { localTest } from '../local-helpers.mjs';
import { file, tempDir } from '../helpers.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { createLocalApi } from '../../lib/local/api.mjs';
import { pack } from '../../lib/tar.mjs';

const BIN = fileURLToPath(new URL('../../cli/headjack', import.meta.url));
const PATH_DIRS = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);

async function vault() {
  const dir = await tempDir('hj-conf-state-');
  const files = [file('SKILL.md', '---\nname: zebra-tool\ndescription: Tracks zebra migrations\n---\n# Use\nCount zebras.')];
  const { api, close } = await createLocalApi({ dir });
  try {
    await api.publish({
      slug: 'zebra-tool', name: 'zebra-tool', description: 'Tracks zebra migrations', kind: 'skill', tags: ['wildlife'],
      source: { kind: 'local' }, sha256: hashFiles(files), status: 'approved', review_notes: 'ok', scan_flags: [],
      chunks: ['zebra-tool: Tracks zebra migrations', 'Count zebras.'],
    }, pack(files));
  } finally {
    close();
  }
  return dir;
}

localTest('the official MCP client lists and calls the tools of `headjack mcp` over stdio', async () => {
  const state = await vault();
  const home = await tempDir('hj-conf-home-');
  // The client's default environment is reduced: pass everything the server needs.
  const transport = new StdioClientTransport({
    command: BIN, args: ['mcp'], env: { HOME: home, HEADJACK_HOME: state, PATH: PATH_DIRS }, stderr: 'pipe',
  });
  const client = new Client({ name: 'conformance', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, 'headjack');
    assert.match(client.getInstructions() ?? '', /local mode/);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['search_skills', 'get_skill', 'list_my_skills', 'install_command']);
    for (const t of tools) assert.equal(t.inputSchema.type, 'object', t.name);

    const text = (result) => JSON.parse(result.content[0].text);
    const found = await client.callTool({ name: 'search_skills', arguments: { query: 'zebra' } });
    assert.notEqual(found.isError, true);
    assert.deepEqual(text(found).results.map((r) => r.slug), ['zebra-tool']);

    const skill = await client.callTool({ name: 'get_skill', arguments: { slug: 'zebra-tool' } });
    assert.match(text(skill).skill_md, /Count zebras/);

    const mine = await client.callTool({ name: 'list_my_skills', arguments: {} });
    assert.deepEqual(text(mine).skills.map((s) => s.slug), ['zebra-tool']);

    const command = await client.callTool({ name: 'install_command', arguments: { slug: 'zebra-tool', harness: 'claude' } });
    assert.equal(text(command).command, "headjack add --to 'claude' --session -- 'zebra-tool'");

    const missing = await client.callTool({ name: 'get_skill', arguments: { slug: 'no-such-skill' } });
    assert.equal(missing.isError, true);
    assert.deepEqual(text(missing), { error: { code: 'not_found' } });
    const invalid = await client.callTool({ name: 'search_skills', arguments: { query: '' } });
    assert.equal(invalid.isError, true);
    assert.deepEqual(text(invalid), { error: { code: 'invalid_input' } });
  } finally {
    await client.close();
  }
  assert.equal(stderr, '');
});
