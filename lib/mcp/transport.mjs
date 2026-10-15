import { randomUUID } from 'node:crypto';
import { ForbiddenError } from '../errors.mjs';

const metadataPath = '/.well-known/oauth-protected-resource/mcp';
const scopes = ['skills:read'];
const publicCors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const unavailable = () => Response.json({ error: { code: 'service_unavailable' } }, { status: 503 });
function browserCors(response, req, config) {
  const origin = req.headers.get('origin');
  if (origin !== null && config?.allowedOrigins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
    response.headers.append('Vary', 'Origin');
  }
  return response;
}

export function createMcpHttp({ enabled, getDependencies, getMetadataConfig }) {
  async function isEnabled() {
    try { return await enabled() === true; } catch { return false; }
  }
  const notFound = () => new Response(null, { status: 404 });
  async function challenge(config, insufficient = false) {
    const { bearerAuthChallengeResponse, OAuthError, OAuthErrorCode } = await import('@modelcontextprotocol/server');
    return bearerAuthChallengeResponse(new OAuthError(
      insufficient ? OAuthErrorCode.InsufficientScope : OAuthErrorCode.InvalidToken,
      insufficient ? 'Insufficient scope' : 'Invalid token',
    ), { requiredScopes: scopes, resourceMetadataUrl: new URL(metadataPath, config.resource).href });
  }
  return {
    async post(req) {
      if (!await isEnabled()) return notFound();
      let config;
      let dependencies;
      let identity;
      try {
        config = await getMetadataConfig();
        const origin = req.headers.get('origin');
        if (origin !== null && !config.allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
        dependencies = await getDependencies();
        identity = await dependencies.identify(req);
      } catch (error) {
        if (error instanceof ForbiddenError && config) return browserCors(await challenge(config, true), req, config);
        return browserCors(unavailable(), req, config);
      }
      if (!identity) return browserCors(await challenge(config), req, config);
      // Only this freshly verified HTTP request supplies context. No shared current-user slot,
      // client session header or token/subject-derived session identifier is used.
      const verifiedContext = Object.freeze({ ownerId: identity.ownerId, sessionId: randomUUID() });
      // Next hands route handlers a Proxy of the request, and `new Request(proxy)` throws on Node's
      // private #state, so build the fresh request from the properties the Proxy reads through.
      const authenticated = new Request(req.url, { method: req.method, headers: req.headers, body: req.body, duplex: 'half', signal: req.signal });
      authenticated.auth = { token: '', clientId: 'headjack', scopes, extra: verifiedContext };
      const { createMcpHandler } = await import('mcp-handler');
      const handler = createMcpHandler((server) => {
        for (const [name, descriptor] of Object.entries(dependencies.tools.schemas)) {
          server.registerTool(name, descriptor, (input, ctx) => dependencies.tools.call(name, input, ctx.http.authInfo.extra));
        }
        // T4 validates these same strict schemas before any repository access. Use the
        // public SDK dispatch API so invalid/unknown calls retain its stable tool error
        // envelope instead of the SDK's unstructured validation-error text.
        server.server.setRequestHandler('tools/call', (request, ctx) => dependencies.tools.call(
          request.params.name, request.params.arguments ?? {}, ctx.http.authInfo.extra,
        ));
      }, { serverInfo: { name: 'headjack', version: '1.0.0' }, maxSubscriptions: 0 });
      try { return browserCors(await handler(authenticated), req, config); }
      catch { return browserCors(unavailable(), req, config); }
    },
    async metadata(req) {
      if (!await isEnabled()) return notFound();
      try {
        const config = await getMetadataConfig();
        const { generateProtectedResourceMetadata } = await import('mcp-handler');
        return Response.json(generateProtectedResourceMetadata({ resourceUrl: config.resource, authServerUrls: [config.issuer], additionalMetadata: { scopes_supported: scopes } }), { headers: publicCors });
      } catch { return unavailable(); }
    },
    async options(req) {
      if (!await isEnabled()) return notFound();
      const metadata = new URL(req.url).pathname === metadataPath;
      return new Response(null, { headers: {
        ...publicCors,
        'Access-Control-Allow-Methods': metadata ? 'GET, OPTIONS' : 'POST, OPTIONS',
        // Authorization is never covered by a CORS wildcard request-header grant.
        ...(!metadata ? { 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version' } : {}),
      } });
    },
    async unsupported(req) {
      if (!await isEnabled()) return notFound();
      return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS' } });
    },
  };
}
