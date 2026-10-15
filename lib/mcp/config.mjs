import { trustedUrl } from '../oauth-config.mjs';

// Configuration is server-owned. Never derive these values from request headers or tool input.
export function loadMcpConfig(env) {
  const resource = trustedUrl(env.MCP_RESOURCE_URL, 'MCP_RESOURCE_URL', { resource: true, suffix: '/mcp' });
  const issuer = trustedUrl(env.HEADJACK_AUTH_SERVER_URL, 'HEADJACK_AUTH_SERVER_URL', { origin: true });
  const origins = (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim());
  const allowedOrigins = [...new Set(origins.map((value) => trustedUrl(value, 'MCP_ALLOWED_ORIGINS', { origin: true })))];
  const cursorSecret = env.MCP_CURSOR_SECRET;
  if (typeof cursorSecret !== 'string' || Buffer.byteLength(cursorSecret, 'utf8') < 32) {
    throw new Error('MCP_CURSOR_SECRET must contain at least 32 UTF-8 bytes');
  }
  return { resource, issuer, allowedOrigins, cursorSecret };
}

// Shared MCP bounds. Archive expansion is enforced by zlib, before tar entries are allocated.
export const MCP_LIMITS = Object.freeze({
  queryChars: 300,
  tagCount: 8,
  tagChars: 64,
  slugChars: 256,
  searchK: 10,
  defaultSearchK: 5,
  pageSize: 50,
  listDescriptionChars: 100,
  listTagCount: 3,
  cursorBytes: 2048,
  archiveBytes: 16 * 1024 * 1024,
  contentBytes: 8192,
});
