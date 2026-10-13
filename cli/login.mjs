import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { UserError } from '../lib/errors.mjs';
import { isApiResourceOf } from '../lib/oauth-config.mjs';
import {
  discoverApi, authServerMetadata, pkcePair, exchangeCode, revokeToken, fetchEmail,
} from './oauth.mjs';
import {
  freshCredential, readCredential, tokenFile, withCredentialLock, writeOAuthCredential,
} from './credentials.mjs';

// `headjack login`, `logout` and `whoami`. The token file is inspected with HEADJACK_TOKEN ignored (an environment key is not a
// file), and every write or delete of it happens inside the credential lock, so a refresh running in another process can
// neither bring back a credential that was logged out nor overwrite a new login. No message or return value carries a token.

const CALLBACK_PORTS = [53437, 53438, 53439];
const CALLBACK_TIMEOUT_MS = 300000;
const PROBE_TIMEOUT_MS = 10000;
const CLI_SCOPE = 'openid email offline_access skills:read skills:write';
const NOT_LOGGED_IN = 'not logged in';

// Opens the authorization URL in the browser; the caller always prints it too, so a failure here is not an error.
export function defaultOpenUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) return;
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

// The status of GET {url}/api/updates with the given bearer. A redirect is never followed: the status is the answer.
async function probeVault(url, token, { fetchImpl }) {
  const target = `${url}/api/updates`;
  let res;
  try {
    res = await fetchImpl(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new UserError(`could not reach ${target}`);
  }
  res.body?.cancel().catch(() => {});
  return res.status;
}

// An existing login is kept unless `force`, which returns it so the caller can revoke it. A corrupt file (or one with loose
// permissions) is what --force repairs: it cannot be read, so `unreadable` is set and nothing can be revoked.
async function refuseExisting(dir, force) {
  let existing;
  try {
    existing = await readCredential({ env: {}, dir });
  } catch (e) {
    if (force && e instanceof UserError) return { previous: null, unreadable: true };
    throw e;
  }
  if (!existing || force) return { previous: existing, unreadable: false };
  if (existing.kind === 'oauth') throw new UserError(`already logged in as ${existing.email}: use --force to log in again`);
  throw new UserError('the token file holds an API key: use --force to replace it');
}

// Revokes the refresh token, then the access token, at the credential's issuer. Best effort: nothing here ever throws, so a
// failed revocation can neither fail a command nor hide the error that led to it. True only when both were revoked.
async function revokePair({ issuer, clientId, refreshToken, accessToken }, fetchImpl) {
  try {
    const { revocationEndpoint } = await authServerMetadata(issuer, { fetchImpl });
    const refresh = await revokeToken({ revocationEndpoint, clientId, token: refreshToken, hint: 'refresh_token' }, { fetchImpl });
    const access = await revokeToken({ revocationEndpoint, clientId, token: accessToken, hint: 'access_token' }, { fetchImpl });
    return refresh && access;
  } catch {
    return false;
  }
}

const PAGE = (message) => `<!doctype html><meta charset="utf-8"><title>Headjack</title><p>${message}</p>`;

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

// Listens on the first free port. Only GET /callback with the exact `state` is ever settled: every other request gets a 404
// (anything but GET /callback, or a target that does not parse) or a 400 (a callback with a wrong or missing state, which
// anything in the browser can forge), and the wait goes on. `code` settles on the first callback with the right state: with
// the authorization code, or with a UserError for a different issuer, a denial, or a missing code. The server is closed by
// `close()`, which waits until the port is released.
export async function startCallbackServer({ ports, state, issuer }) {
  let settle;
  const code = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  code.catch(() => {});
  let settled = false;
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(body);
  };
  const handler = (req, res) => {
    // A request target such as `//` does not parse against a base; it is a stray request like any other.
    let url = null;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch {}
    if (settled || !url || req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { connection: 'close' }).end();
      return;
    }
    const params = url.searchParams;
    if (params.get('state') !== state) {
      reply(res, 400, PAGE('This is not the Headjack login callback.'));
      return;
    }
    settled = true;
    try {
      if (params.has('iss') && params.get('iss') !== issuer) throw new UserError(`the login callback came from a different issuer than ${issuer}`);
      if (params.has('error')) throw new UserError('login was not approved');
      if (!params.get('code')) throw new UserError('the login callback carried no code');
      reply(res, 200, PAGE('Headjack login complete. You can close this tab.'));
      settle.resolve(params.get('code'));
    } catch (e) {
      reply(res, 400, PAGE('Headjack login failed. Return to the terminal.'));
      settle.reject(e);
    }
  };
  let server;
  let port;
  for (const candidate of ports) {
    server = createServer(handler);
    try {
      port = await listenOnce(server, candidate);
      break;
    } catch (e) {
      server.close();
      if (e.code !== 'EADDRINUSE') throw new UserError(`could not listen on 127.0.0.1:${candidate} for the login callback (${e.code ?? e.message})`, { cause: e });
    }
  }
  if (port === undefined) throw new UserError(`callback ports ${ports.join(', ')} are busy`);
  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return { port, code, close };
}

export async function login({ url, dir, force = false, env = process.env }, {
  fetchImpl = fetch, openUrl = defaultOpenUrl, ports = CALLBACK_PORTS, timeoutMs = CALLBACK_TIMEOUT_MS, log = console.log,
} = {}) {
  await refuseExisting(dir, force);
  const { resource, issuer, clientId } = await discoverApi(url, { fetchImpl });
  const { authorizationEndpoint, tokenEndpoint, userinfoEndpoint } = await authServerMetadata(issuer, { fetchImpl });
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(32).toString('base64url');

  const callback = await startCallbackServer({ ports, state, issuer });
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  let code;
  let timer;
  try {
    const authorize = new URL(authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: CLI_SCOPE,
      resource,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })) authorize.searchParams.set(key, value);
    log(`Open this URL to log in:\n${authorize.href}`);
    // The URL is printed above, so a browser that fails to open is not an error.
    Promise.resolve().then(() => openUrl(authorize.href)).catch(() => {});
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new UserError('login timed out after 5 minutes')), timeoutMs);
    });
    code = await Promise.race([callback.code, timedOut]);
  } finally {
    clearTimeout(timer);
    await callback.close();
  }

  const tokens = await exchangeCode({ tokenEndpoint, clientId, code, verifier, redirectUri, resource }, { fetchImpl });
  // From here the issuer holds a live pair that nothing local refers to yet: a failure before the save revokes it.
  const minted = { issuer, clientId, ...tokens };
  let replaced = { previous: null, unreadable: false };
  let saved = false;
  try {
    const email = await fetchEmail({ userinfoEndpoint, accessToken: tokens.accessToken }, { fetchImpl });
    // Proves the vault accepts the new token, directly and outside the refresh path, before anything is saved.
    const status = await probeVault(url, tokens.accessToken, { fetchImpl });
    if (status !== 200) throw new UserError(`${url}/api/updates answered HTTP ${status}: the login was not saved`);

    try {
      replaced = await withCredentialLock(dir, async () => {
        const found = await refuseExisting(dir, force);
        await writeOAuthCredential(dir, { issuer, clientId, resource, email, ...tokens });
        return found;
      });
      saved = true;
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(`could not save the login to ${tokenFile(dir)} (${e.code ?? e.message})`, { cause: e });
    }
    if (env.HEADJACK_TOKEN) log('warning: HEADJACK_TOKEN is set and overrides this login; unset it to use the new login');
    // `login --force` over an OAuth login: the old pair is no longer referenced, so it is revoked rather than left valid. The
    // issuer may treat a login of the same client as one grant, so revoking it would kill the login just saved: the old pair
    // is revoked only when the issuer or the client differs.
    const { previous } = replaced;
    if (replaced.unreadable) log('the previous login could not be read, so it was not revoked');
    else if (previous?.kind === 'oauth' && (previous.issuer !== issuer || previous.clientId !== clientId)) await revokePair(previous, fetchImpl);
    return { email };
  } catch (e) {
    if (!saved) await revokePair(minted, fetchImpl);
    throw e;
  }
}

function requireOAuth(credential) {
  if (!credential) throw new UserError(NOT_LOGGED_IN);
  if (credential.kind === 'api-key') throw new UserError('API keys are revoked on the server; the token file was left in place');
}

// The file is deleted under the lock, and the tokens revoked are the ones read there, so a refresh that rotated them
// meanwhile is not left valid at the issuer. Revocation is best effort: its failure never keeps the file.
export async function logout({ dir }, { fetchImpl = fetch } = {}) {
  requireOAuth(await readCredential({ env: {}, dir }));
  let stored;
  try {
    stored = await withCredentialLock(dir, async () => {
      const current = await readCredential({ env: {}, dir });
      requireOAuth(current);
      await unlink(tokenFile(dir));
      return current;
    });
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`could not remove ${tokenFile(dir)} (${e.code ?? e.message})`, { cause: e });
  }
  return { revoked: await revokePair(stored, fetchImpl) };
}

export async function whoami({ url, dir, env = process.env }, { fetchImpl = fetch } = {}) {
  const credential = await readCredential({ env, dir });
  if (!credential) throw new UserError(NOT_LOGGED_IN);
  if (credential.kind === 'api-key') {
    return { kind: 'api-key', source: credential.source, status: await probeVault(url, credential.token, { fetchImpl }) };
  }
  if (!isApiResourceOf(credential.resource, url)) throw new UserError('the saved login is for another server: run headjack login --force');
  let current = await freshCredential({ dir, credential }, { fetchImpl });
  let status = await probeVault(url, current.accessToken, { fetchImpl });
  if (status === 401) {
    current = await freshCredential({ dir, credential: current, rejectedToken: current.accessToken }, { fetchImpl });
    status = await probeVault(url, current.accessToken, { fetchImpl });
  }
  return { kind: 'oauth', source: current.source, email: current.email, expiresAt: current.expiresAt, status };
}
