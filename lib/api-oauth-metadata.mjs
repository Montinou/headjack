import { loadApiOAuthConfig } from './oauth-config.mjs';

const scopes = ['skills:read', 'skills:write'];
const publicCors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

// RFC 9728 protected-resource metadata for the REST API, plus the CLI's public client id. Everything it publishes is
// server-owned configuration; nothing derives from the request. Off (or a failing flag) is an empty 404, like the MCP
// discovery; a missing or invalid configuration is a bodyless-detail 503.
export function apiOAuthMetadata({ isEnabled, env }) {
  async function enabled() {
    try { return await isEnabled() === true; } catch { return false; }
  }
  const notFound = () => new Response(null, { status: 404 });
  return {
    async metadata(_req) {
      if (!await enabled()) return notFound();
      let config;
      try { config = loadApiOAuthConfig(env); } catch { config = null; }
      if (!config?.cliClientId) return Response.json({ error: { code: 'service_unavailable' } }, { status: 503 });
      return Response.json({
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: scopes,
        bearer_methods_supported: ['header'],
        headjack_cli_client_id: config.cliClientId,
      }, { headers: { ...publicCors, 'Cache-Control': 'public, max-age=300' } });
    },
    async options(_req) {
      if (!await enabled()) return notFound();
      return new Response(null, { status: 204, headers: publicCors });
    },
  };
}
