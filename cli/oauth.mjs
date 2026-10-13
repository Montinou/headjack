import { createHash, randomBytes } from 'node:crypto';
import { UserError } from '../lib/errors.mjs';
import { canonicalUrl, isSecureUrl } from '../lib/oauth-config.mjs';

// OAuth protocol client for the CLI: discovery, PKCE, token exchange, refresh, revocation and userinfo. Pure protocol:
// no file access and no UI. Every failure is a one-line UserError naming the URL; no message ever carries a token.

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

// Releases an unread body without waiting on it.
function discard(res) {
  res.body?.cancel().catch(() => {});
}

function fail(message) {
  return new UserError(message);
}

const DEFAULT_TIMEOUT_MS = 10000;
// Interactive calls (discovery, the code exchange, userinfo) wait longer than the background ones, but never forever.
const INTERACTIVE_TIMEOUT_MS = 30000;

function timeoutSignal(timeoutMs) {
  return timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
}

// A transport (or body) that ignores the signal must not outlive the timeout.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  promise.catch(() => {});
  const aborted = new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return Promise.race([promise, aborted]);
}

function isTimeout(e) {
  return e?.name === 'TimeoutError' || e?.name === 'AbortError';
}

function timeoutError(url, timeoutMs) {
  const within = Number.isFinite(timeoutMs) ? `within ${Math.ceil(timeoutMs / 1000)}s` : 'in time';
  return fail(`${url} did not answer ${within}`);
}

async function call(fetchImpl, url, init = {}, { signal, timeoutMs } = {}) {
  try {
    return await raceAbort(fetchImpl(url, signal ? { ...init, signal } : init), signal);
  } catch (e) {
    throw isTimeout(e) ? timeoutError(url, timeoutMs) : fail(`could not reach ${url}`);
  }
}

async function readJson(res, url, { signal, timeoutMs } = {}) {
  try {
    const body = await raceAbort(res.json(), signal);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch (e) {
    if (isTimeout(e)) throw timeoutError(url, timeoutMs);
  }
  throw fail(`${url} did not return a JSON object`);
}

async function getJson(fetchImpl, url, headers, { signal, timeoutMs } = {}) {
  const res = await call(fetchImpl, url, headers ? { headers } : {}, { signal, timeoutMs });
  if (!res.ok) {
    discard(res);
    throw fail(`${url} answered HTTP ${res.status}`);
  }
  return readJson(res, url, { signal, timeoutMs });
}

function secureUrl(value, url, field) {
  try {
    if (typeof value === 'string' && isSecureUrl(new URL(value))) return value;
  } catch {}
  throw fail(`${url} has no usable ${field}`);
}

const oauthErrorCode = /^[A-Za-z0-9_.-]{1,64}$/;

// Token bodies are never replayed to a redirect target: a redirecting authorization server is refused.
async function postForm(fetchImpl, url, params, { timeoutMs } = {}) {
  const signal = timeoutSignal(timeoutMs);
  const res = await call(fetchImpl, url, { method: 'POST', headers: FORM, body: new URLSearchParams(params), redirect: 'error' }, { signal, timeoutMs });
  if (!res.ok) {
    let code = `HTTP ${res.status}`;
    try {
      const body = await raceAbort(res.json(), signal);
      if (typeof body?.error === 'string' && oauthErrorCode.test(body.error)) code = body.error;
    } catch {}
    // The marker lets callers tell the issuer rejecting the grant (a 4xx) from the issuer being unwell (5xx, 429, 408),
    // without matching message text.
    const refusal = fail(`${url} refused the request (${code})`);
    refusal.oauthRefusal = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw refusal;
  }
  return readJson(res, url, { signal, timeoutMs });
}

function readTokens(body, url, fallbackRefreshToken) {
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : fallbackRefreshToken;
  if (typeof body.access_token !== 'string' || !body.access_token || !refreshToken
    || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw fail(`${url} returned an incomplete token response`);
  }
  return { accessToken: body.access_token, refreshToken, expiresAt: Date.now() + body.expires_in * 1000 };
}

// `headers` go on this one request only; the issuer never sees them.
export async function discoverApi(headjackUrl, { fetchImpl = fetch, headers, timeoutMs = INTERACTIVE_TIMEOUT_MS } = {}) {
  const base = canonicalUrl(headjackUrl) ?? headjackUrl.replace(/\/+$/, '');
  const url = `${base}/.well-known/oauth-protected-resource/api`;
  const bound = { signal: timeoutSignal(timeoutMs), timeoutMs };
  // A redirect is never followed, so the extra headers cannot reach another origin.
  const res = await call(fetchImpl, url, { redirect: 'manual', ...(headers ? { headers } : {}) }, bound);
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    discard(res);
    throw fail(`${url} redirected; refusing to follow it`);
  }
  if (res.status === 404) {
    discard(res);
    throw fail('this server has not enabled CLI login');
  }
  if (!res.ok) {
    discard(res);
    throw fail(`${url} answered HTTP ${res.status}`);
  }
  const doc = await readJson(res, url, bound);
  if (canonicalUrl(doc.resource) !== `${base}/api`) throw fail(`${url} describes a different resource than ${base}/api`);
  const servers = doc.authorization_servers;
  if (!Array.isArray(servers) || servers.length !== 1 || typeof servers[0] !== 'string' || !servers[0]) {
    throw fail(`${url} must name exactly one authorization server`);
  }
  if (typeof doc.headjack_cli_client_id !== 'string' || !doc.headjack_cli_client_id) {
    throw fail(`${url} has no CLI client id`);
  }
  return { resource: doc.resource, issuer: servers[0], clientId: doc.headjack_cli_client_id };
}

// Both documents share one deadline (`timeoutMs`), so a silent issuer cannot stall a caller, such as a refresh, for long.
export async function authServerMetadata(issuer, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  secureUrl(issuer, issuer, 'issuer');
  const base = issuer.replace(/\/+$/, '');
  const oauthUrl = `${base}/.well-known/oauth-authorization-server`;
  const openidUrl = `${base}/.well-known/openid-configuration`;
  const bound = { signal: timeoutSignal(timeoutMs), timeoutMs };
  const [oauth, openid] = await Promise.all([getJson(fetchImpl, oauthUrl, undefined, bound), getJson(fetchImpl, openidUrl, undefined, bound)]);
  if (oauth.issuer !== issuer) throw fail(`${oauthUrl} names a different issuer than ${issuer}`);
  if (openid.issuer !== issuer) throw fail(`${openidUrl} names a different issuer than ${issuer}`);
  if (!Array.isArray(oauth.code_challenge_methods_supported) || !oauth.code_challenge_methods_supported.includes('S256')) {
    throw fail(`${oauthUrl} does not support PKCE S256`);
  }
  return {
    authorizationEndpoint: secureUrl(oauth.authorization_endpoint, oauthUrl, 'authorization_endpoint'),
    tokenEndpoint: secureUrl(oauth.token_endpoint, oauthUrl, 'token_endpoint'),
    revocationEndpoint: secureUrl(oauth.revocation_endpoint, oauthUrl, 'revocation_endpoint'),
    userinfoEndpoint: secureUrl(openid.userinfo_endpoint, openidUrl, 'userinfo_endpoint'),
  };
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function exchangeCode({ tokenEndpoint, clientId, code, verifier, redirectUri, resource }, { fetchImpl = fetch, timeoutMs = INTERACTIVE_TIMEOUT_MS } = {}) {
  const body = await postForm(fetchImpl, tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
  }, { timeoutMs });
  return readTokens(body, tokenEndpoint);
}

export async function refreshTokens({ tokenEndpoint, clientId, refreshToken, resource }, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const body = await postForm(fetchImpl, tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  }, { timeoutMs });
  return readTokens(body, tokenEndpoint, refreshToken);
}

// RFC 7009: best effort. A failure is reported as false so logout can still delete the local file.
export async function revokeToken({ revocationEndpoint, clientId, token, hint }, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const res = await call(fetchImpl, revocationEndpoint, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }),
      redirect: 'error',
    }, { signal: timeoutSignal(timeoutMs), timeoutMs });
    discard(res);
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchEmail({ userinfoEndpoint, accessToken }, { fetchImpl = fetch, timeoutMs = INTERACTIVE_TIMEOUT_MS } = {}) {
  const body = await getJson(fetchImpl, userinfoEndpoint, { authorization: `Bearer ${accessToken}` }, { signal: timeoutSignal(timeoutMs), timeoutMs });
  if (typeof body.email !== 'string' || !body.email) throw fail(`${userinfoEndpoint} returned no email`);
  return body.email;
}
