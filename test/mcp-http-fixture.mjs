import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createClerkClient } from '@clerk/backend';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHttp } from '../lib/mcp/transport.mjs';
import { mcpOAuthResolver } from '../lib/mcp/identity.mjs';
import { createMcpTools } from '../lib/mcp/tools.mjs';
import { createIdentity } from '../lib/identity.mjs';
import { createDb } from '../lib/db.mjs';
import { repoForOwner } from '../lib/repo.mjs';
import { pack } from '../lib/tar.mjs';
import { appPool, migratedPg, closePg, vec } from './pglite.mjs';

// Test-only configuration also bounds the built Next smoke. No real credentials/providers are used.
export const MCP_TEST_CONFIG = Object.freeze({ readinessMs: 30_000, requestMs: 5_000, pollMs: 100, shutdownMs: 5_000, quotaAttempts: 3 });
export const MCP_TEST_SLUGS = ['A', 'Z', 'a', ...Array.from({ length: 46 }, (_, i) => `item-${String(i).padStart(2, '0')}`), 'z', 'é', '😀'];
export const fixtureBody = (user, slug) => `---\nname: ${slug}\n---\n# Private ${user} ${slug}\n`;
export const fixtureSource = (user) => `https://github.com/fixture/${user}`;

export async function mcpHttpFixture() {
  const pg = await migratedPg();
  const pool = appPool(pg);
  const db = createDb(pool);
  const users = new Map(['user_A', 'user_B', 'user_C'].map((id) => [id, {
    object: 'user', id, banned: false, locked: false, primary_email_address_id: `email_${id}`,
    email_addresses: [{ object: 'email_address', id: `email_${id}`, email_address: `${id}@fixture.invalid`, verification: { status: 'verified' }, linked_to: [] }],
  }]));
  const grants = new Map();
  const events = { grants: 0, users: 0, owners: 0, repos: 0, embeds: 0, contexts: [], methods: [], statuses: [] };
  const state = { embedFailure: false, providerFailure: false };
  let http, origin;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, origin);
      // Simulated provider verification over loopback. The real Clerk SDK performs request encoding,
      // resource deserialization and audience checking; this does not prove live Clerk OAuth grants.
      if (url.pathname === '/fixture-clerk/oauth_applications/access_tokens/verify') {
        events.grants++;
        if (state.providerFailure) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ code: 'fixture_unavailable', message: 'private provider diagnostic' }] }));
          return;
        }
        const grant = grants.get(JSON.parse(body).access_token);
        res.writeHead(grant ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(grant ?? { errors: [{ code: 'invalid_token', message: 'private token diagnostic' }] }));
        return;
      }
      if (url.pathname.startsWith('/fixture-clerk/v1/users/')) {
        events.users++;
        const user = users.get(url.pathname.split('/').at(-1));
        res.writeHead(user ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(user ?? { errors: [{ code: 'not_found', message: 'private profile diagnostic' }] }));
        return;
      }
      if (req.method === 'POST') events.methods.push(JSON.parse(body).method);
      const request = new Request(url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) });
      const response = url.pathname === '/mcp'
        ? await http[req.method === 'POST' ? 'post' : req.method === 'OPTIONS' ? 'options' : 'unsupported'](request)
        : url.pathname === '/.well-known/oauth-protected-resource/mcp'
          ? await http[req.method === 'OPTIONS' ? 'options' : 'metadata'](request)
          : new Response(null, { status: 404 });
      events.statuses.push(response.status);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500); res.end('fixture request failed');
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    const config = { resource: `${origin}/mcp`, issuer: origin, allowedOrigins: [origin], cursorSecret: 'local-' + 'fixture-cursor-secret-at-least-32-bytes' };
    const clerk = createClerkClient({ apiUrl: `${origin}/fixture-clerk`, publishableKey: `pk_test_${Buffer.from('fixture.invalid$').toString('base64')}`, secretKey: 'sk_test_fixture', telemetry: { disabled: true } });
    for (const id of users.keys()) {
      grants.set(`oat_${id}`, { object: 'clerk_idp_oauth_access_token', id: `grant_${id}`, client_id: 'fixture', type: 'opaque', subject: id,
        scopes: ['skills:read'], aud: [config.resource], revoked: false, revocation_reason: null, expired: false, expiration: null, created_at: 1, updated_at: 1 });
    }
    const identity = createIdentity({ resolvers: [mcpOAuthResolver({ config, getClient: async () => clerk })], resolveOwner: async (...args) => {
      events.owners++; return db.resolveOwner(...args);
    } });
    const tools = createMcpTools({ repoFor: (id) => { events.repos++; return repoForOwner(db.withOwner, id); }, cursorSecret: config.cursorSecret,
      embed: async () => { events.embeds++; if (state.embedFailure) throw Error('private embedding credential diagnostic'); return [vec(0)]; },
      resolveFlags: async (_req, context) => { events.contexts.push(context); return {}; },
    });
    http = createMcpHttp({ enabled: async () => true, getMetadataConfig: () => config, getDependencies: async () => ({ identify: identity.identify, tools }) });
    const owners = {};
    // Seed with the actual owner repository and stored tar archive, never a public owner parameter.
    for (const id of ['user_A', 'user_B']) {
      const who = await identity.identify(new Request(config.resource, { headers: { authorization: `Bearer oat_${id}` } }));
      owners[id] = who.ownerId;
      const repo = repoForOwner(db.withOwner, who.ownerId);
      for (const slug of [...MCP_TEST_SLUGS, `only-${id}`]) {
        const tarball = pack([{ path: 'SKILL.md', mode: 0o644, data: Buffer.from(fixtureBody(id, slug)) }]);
        await repo.publish({ manifest: { slug, name: `${id} ${slug}`, description: `Private catalog ${id} ${slug}`, kind: 'skill',
          tags: [id, ...(slug === '😀' ? ['target'] : [])], source: { kind: 'github', url: fixtureSource(id) }, source_path: `skills/${slug}`,
          sha256: createHash('sha256').update(tarball).digest('hex'), status: 'approved', review_notes: 'fixture', scan_flags: [] },
          tarball, chunks: [{ text: `Private catalog ${id} ${slug}`, embedding: vec(0), kind: 'content' }] });
      }
    }
    const clients = new Set();
    async function connect(token = 'oat_' + 'user_A', { scheme = 'Bearer', spaces = 1 } = {}) {
      const auth = { token, scheme, spaces };
      const client = new Client({ name: 'rls-http-fixture', version: '1.0.0' }, { supportedProtocolVersions: ['2025-03-26'] });
      const transport = new StreamableHTTPClientTransport(new URL(config.resource), {
        fetch: (url, init) => {
          const headers = new Headers(init.headers);
          headers.set('authorization', `${auth.scheme}${' '.repeat(auth.spaces)}${auth.token}`);
          // Spoofed public context must not choose database or Flags identity.
          headers.set('x-owner-id', '1'); headers.set('mcp-session-id', 'client-chosen-session');
          return fetch(url, { ...init, headers, signal: AbortSignal.timeout(MCP_TEST_CONFIG.requestMs) });
        },
      });
      try { await client.connect(transport); } catch (error) { await client.close(); throw error; }
      clients.add(client);
      return { client, auth, transport };
    }
    async function snapshot() {
      await pool.query('select 1'); // Wait for the serialized app-role pool and its reset before operator inspection.
      return (await pg.query(`select (select count(*)::int from owners) as owners,
        (select count(*)::int from skills) as skills, (select count(*)::int from versions) as versions,
        (select coalesce(sum(used),0)::int from app.mcp_search_budget) as budget`)).rows[0];
    }
    return { pg, pool, db, config, events, state, users, grants, owners, connect, snapshot,
      async close() {
        await Promise.allSettled([...clients].map((client) => client.close()));
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        await closePg(pg);
      },
    };
  } catch (error) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await closePg(pg); throw error;
  }
}
