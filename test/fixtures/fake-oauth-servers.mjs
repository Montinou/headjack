import { createServer } from 'node:http';

// Fake authorization server and fake Headjack on 127.0.0.1 with random ports (never the CLI's real callback ports), shared by the
// login/logout/whoami tests. Every request is recorded as { method, path, headers, body } with a parsed form body.

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

function listen(server) {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
}

function wrap(server, requests, extra) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    ...extra,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

export const ISSUER_TOKENS = { accessToken: 'at-login-1', refreshToken: 'rt-login-1' };

// tokenStatus/revokeStatus/userinfoStatus: HTTP status of that endpoint. email: what userinfo returns. tokenEndpoint: the
// token endpoint URL the metadata advertises (default: this server's own, e.g. a dead port to simulate an outage).
export async function startIssuer({
  tokenStatus = 200, revokeStatus = 200, userinfoStatus = 200, email = 'ana@example.invalid', tokenEndpoint,
} = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const text = await readBody(req);
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: Object.fromEntries(new URLSearchParams(text)) });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case '/.well-known/oauth-authorization-server':
        return send(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: tokenEndpoint ?? `${origin}/oauth/token`,
          revocation_endpoint: `${origin}/oauth/revoke`,
          code_challenge_methods_supported: ['S256'],
        });
      case '/.well-known/openid-configuration':
        return send(200, { issuer: origin, userinfo_endpoint: `${origin}/oauth/userinfo` });
      case '/oauth/token':
        return tokenStatus === 200
          ? send(200, { access_token: ISSUER_TOKENS.accessToken, refresh_token: ISSUER_TOKENS.refreshToken, expires_in: 3600, token_type: 'Bearer' })
          : send(tokenStatus, { error: 'invalid_grant' });
      case '/oauth/revoke':
        return send(revokeStatus, {});
      case '/oauth/userinfo':
        return userinfoStatus === 200 ? send(200, { email }) : send(userinfoStatus, { error: 'denied' });
      default:
        return send(404, {});
    }
  });
  await listen(server);
  return wrap(server, requests, {});
}

// issuer: the authorization server's origin. discovery: false answers 404 (CLI login not enabled). updatesStatus: the status of
// GET /api/updates; accepted (a Set of bearer tokens), when given, makes any other bearer a 401.
export async function startHeadjack({ issuer, clientId = 'client_cli', discovery = true, updatesStatus = 200, accepted } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/oauth-protected-resource/api') {
      if (!discovery) return send(404, {});
      return send(200, {
        resource: `${origin}/api`,
        authorization_servers: [issuer],
        scopes_supported: ['skills:read', 'skills:write'],
        bearer_methods_supported: ['header'],
        headjack_cli_client_id: clientId,
      });
    }
    if (url.pathname === '/api/updates') {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      if (accepted && !accepted.has(bearer)) return send(401, { error: { code: 'unauthorized', message: 'bad token' } });
      return send(updatesStatus, { updates: [] });
    }
    return send(404, {});
  });
  await listen(server);
  return wrap(server, requests, {});
}
