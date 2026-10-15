// Acceptance MCP client for the preview (spec §6 steps 4-7). Tokens never appear on a command line or stdout.
//
//   node scripts/acceptance-mcp.mjs token --issuer <url> --client-id <headjack-mcp id> --resource <MCP_RESOURCE_URL> --out <file>
//   node scripts/acceptance-mcp.mjs call --url <mcp url> --token-file <file> --tool <name> --args '<json>'
//   node scripts/acceptance-mcp.mjs rest --url <headjack url> --token-file <file> --path /api/updates
//   node scripts/acceptance-mcp.mjs revoke --token-file <file>
//   node scripts/acceptance-mcp.mjs refresh --token-file <file>
//   node scripts/acceptance-mcp.mjs paced-search --url <mcp url> --token-file <file> --count 61 --per-second 4
//
// token   runs a PKCE flow with the headjack-mcp client on its registered callback http://localhost:53436/callback, prints the
//         authorization URL (for the browser automation) and `token written`, and writes the grant to --out with mode 600
//         (refused inside any git checkout, or when ::1 / [::] already holds the callback port).
// call    sends one JSON-RPC `initialize` and one `tools/call` to --url and prints the tool result.
// rest    GETs --url + --path with the bearer and prints only the HTTP status.
// revoke  revokes the refresh token, then the access token (RFC 7009). refresh prints `refresh succeeded`, or `refresh failed (<code>)`
//         only when the issuer refuses the grant (a timeout, 5xx or 429 is an error, exit 2); it writes the rotated pair back.
// paced-search waits for the start of the next minute, then makes --count search_skills calls at no more than --per-second.
//
// --token-file takes this script's file or a CLI credential file (the CLI's keys are a superset). When
// VERCEL_AUTOMATION_BYPASS_SECRET is in use, --url is the bypass proxy's loopback address: this script adds no header.
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UserError } from '../lib/errors.mjs';
import { startCallbackServer } from '../cli/login.mjs';
import {
  authServerMetadata, exchangeCode, pkcePair, refreshTokens, revokeToken,
} from '../cli/oauth.mjs';

export const MCP_CALLBACK_PORT = 53436;
export const MCP_SCOPE = 'skills:read offline_access';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const CALLBACK_TIMEOUT_MS = 300000;
const REQUEST_TIMEOUT_MS = 30000;
const MINUTE_MS = 60000;
const SECOND_MS = 1000;
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN_KEYS = ['access_token', 'refresh_token', 'client_id', 'resource', 'issuer'];
const USAGE = `usage: node scripts/acceptance-mcp.mjs <command> [flags]
  token --issuer <url> --client-id <id> --resource <url> --out <file outside the repository>
  call --url <mcp url> --token-file <file> --tool <name> --args '<json>'
  rest --url <headjack url> --token-file <file> --path <path>
  revoke --token-file <file>
  refresh --token-file <file>
  paced-search --url <mcp url> --token-file <file> --count <n> --per-second <n>`;

const COMMANDS = {
  token: { '--issuer': 'issuer', '--client-id': 'clientId', '--resource': 'resource', '--out': 'out' },
  call: { '--url': 'url', '--token-file': 'tokenFile', '--tool': 'tool', '--args': 'args' },
  rest: { '--url': 'url', '--token-file': 'tokenFile', '--path': 'path' },
  revoke: { '--token-file': 'tokenFile' },
  refresh: { '--token-file': 'tokenFile' },
  'paced-search': { '--url': 'url', '--token-file': 'tokenFile', '--count': 'count', '--per-second': 'perSecond' },
};

// --- token files -----------------------------------------------------------------------------------------------------

// Reads this script's token file or a CLI credential file; the five keys are common to both. Errors name the file only.
export async function readTokenFile(file) {
  let doc;
  try {
    doc = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') throw new UserError(`${file} does not exist`);
    throw new UserError(`${file} is not a token file`);
  }
  if (!doc || typeof doc !== 'object' || TOKEN_KEYS.some((key) => typeof doc[key] !== 'string' || !doc[key])) {
    throw new UserError(`${file} is not a token file (needs ${TOKEN_KEYS.join(', ')})`);
  }
  return {
    accessToken: doc.access_token, refreshToken: doc.refresh_token, clientId: doc.client_id, resource: doc.resource, issuer: doc.issuer, doc,
  };
}

// Atomic write with mode 600 from the first byte, so the grant is never readable by others.
async function writeTokenFile(out, grant) {
  await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  const tmp = `${out}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(grant)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new UserError(`could not write ${out} (${e.code ?? 'error'})`);
  }
}

const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const exists = (target) => lstat(target).then(() => true, (e) => {
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return false;
  throw new UserError(`could not inspect ${target} (${e?.code ?? 'error'})`);
});

// The real location of `target` even when the file (and some directories above it) do not exist yet: the nearest existing
// ancestor is resolved through symlinks and the missing tail is appended.
async function resolveReal(target) {
  const tail = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail);
    } catch (e) {
      const parent = path.dirname(current);
      if ((e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') || parent === current) throw new UserError(`could not resolve ${target} (${e?.code ?? 'error'})`);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// The grant must never land in any git checkout (this worktree, the main checkout or another): refused when the real path is
// inside this repository or any directory above it holds a `.git` entry (a directory, or the file a worktree has).
async function assertOutsideRepo(out) {
  const real = await resolveReal(out);
  let inside = isInside(await realpath(REPO_ROOT), real);
  let dir = path.dirname(real);
  while (!inside) {
    if (await exists(path.join(dir, '.git'))) inside = true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (inside) throw new UserError(`${out} must be outside the repository and any git checkout`);
}

// Chrome may deliver the callback to ::1 or [::], which another program (Claude Code, for one) can own while the 127.0.0.1
// bind still succeeds. A port that cannot be bound on either is refused. Only EADDRINUSE counts: no IPv6 is no conflict.
async function ipv6Free(port) {
  for (const host of ['::1', '::']) {
    const probe = createServer();
    const busy = await new Promise((resolve) => {
      probe.once('error', (e) => resolve(e?.code === 'EADDRINUSE'));
      probe.listen(port, host, () => resolve(false));
    });
    await new Promise((resolve) => { probe.close(() => resolve()); });
    if (busy) return false;
  }
  return true;
}

// --- token -----------------------------------------------------------------------------------------------------------

export async function mintMcpToken({ issuer, clientId, resource, out }, {
  fetchImpl = fetch, log = console.log, ports = [MCP_CALLBACK_PORT], timeoutMs = CALLBACK_TIMEOUT_MS,
} = {}) {
  await assertOutsideRepo(out);
  const free = [];
  for (const port of ports) if (await ipv6Free(port)) free.push(port);
  if (!free.length) throw new UserError(`port ${ports.join(', ')} is in use on ::1 or [::]: free it so the browser's callback reaches this script`);
  const { authorizationEndpoint, tokenEndpoint } = await authServerMetadata(issuer, { fetchImpl });
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(32).toString('base64url');
  const callback = await startCallbackServer({ ports: free, state, issuer });
  const redirectUri = `http://localhost:${callback.port}/callback`;
  let code;
  let timer;
  try {
    const authorize = new URL(authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: MCP_SCOPE,
      resource,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })) authorize.searchParams.set(key, value);
    log(authorize.href);
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new UserError('the authorization was not approved within 5 minutes')), timeoutMs);
    });
    code = await Promise.race([callback.code, timedOut]);
  } finally {
    clearTimeout(timer);
    await callback.close();
  }
  const tokens = await exchangeCode({ tokenEndpoint, clientId, code, verifier, redirectUri, resource }, { fetchImpl });
  await writeTokenFile(out, {
    access_token: tokens.accessToken, refresh_token: tokens.refreshToken, client_id: clientId, resource, issuer,
  });
  log('token written');
}

// --- MCP over HTTP ---------------------------------------------------------------------------------------------------

// The reply is a JSON body or an event stream carrying one JSON-RPC message.
async function readRpc(res, url) {
  const text = await res.text();
  const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
    : text;
  try {
    const message = JSON.parse(data);
    if (message && typeof message === 'object') return message;
  } catch {}
  throw new UserError(`${url} did not return a JSON-RPC message`);
}

async function rpc(url, token, body, { fetchImpl, withVersion }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(withVersion ? { 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new UserError(`could not reach ${url}`);
  }
  if (res.status !== 200) {
    res.body?.cancel().catch(() => {});
    throw new UserError(`${url} answered HTTP ${res.status}`);
  }
  const message = await readRpc(res, url);
  if (message.error) throw new UserError(`${url} returned a JSON-RPC error (${message.error.code ?? 'unknown'})`);
  return message.result;
}

export async function callTool({ url, token, tool, args }, { fetchImpl = fetch } = {}) {
  await rpc(url, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'headjack-acceptance', version: '1.0.0' } },
  }, { fetchImpl, withVersion: false });
  return rpc(url, token, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args },
  }, { fetchImpl, withVersion: true });
}

// --- REST, revocation and refresh ------------------------------------------------------------------------------------

// The bearer goes only where --url points: the path is a single-slash absolute path and the result keeps the --url origin.
function restTarget(url, requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/') || /^\/[/\\]/.test(requestPath)) {
    throw new UserError('--path must start with a single "/"');
  }
  const target = `${url.replace(/\/+$/, '')}${requestPath}`;
  try {
    if (new URL(target).origin === new URL(url).origin) return target;
  } catch {}
  throw new UserError('--path must stay on the --url origin');
}

export async function restStatus({ url, token, path: requestPath }, { fetchImpl = fetch } = {}) {
  const target = restTarget(url, requestPath);
  let res;
  try {
    res = await fetchImpl(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new UserError(`could not reach ${target}`);
  }
  res.body?.cancel().catch(() => {});
  return res.status;
}

// The refresh token first, then the access token; each outcome is reported, neither stops the other.
export async function revokeGrant({ file }, { fetchImpl = fetch } = {}) {
  const grant = await readTokenFile(file);
  const { revocationEndpoint } = await authServerMetadata(grant.issuer, { fetchImpl });
  const refresh = await revokeToken({ revocationEndpoint, clientId: grant.clientId, token: grant.refreshToken, hint: 'refresh_token' }, { fetchImpl });
  const access = await revokeToken({ revocationEndpoint, clientId: grant.clientId, token: grant.accessToken, hint: 'access_token' }, { fetchImpl });
  return { refresh, access };
}

// Spec §6 step 7 reads "refresh failed" as proof that a revoked grant cannot recover, so only the issuer refusing the grant
// (`oauthRefusal`) counts: { refreshed: false, code } with the OAuth error code. A timeout, a 5xx or 429, a discovery error or a
// failed fetch is rethrown as a one-line UserError. On success the rotated pair is written back to the same file (mode 600,
// its other keys kept), so a later `revoke` uses the live refresh token.
export async function tryRefresh({ file }, { fetchImpl = fetch } = {}) {
  const grant = await readTokenFile(file);
  let tokens;
  try {
    const { tokenEndpoint } = await authServerMetadata(grant.issuer, { fetchImpl });
    tokens = await refreshTokens({ tokenEndpoint, clientId: grant.clientId, refreshToken: grant.refreshToken, resource: grant.resource }, { fetchImpl });
  } catch (e) {
    if (e?.oauthRefusal === true) return { refreshed: false, code: /refused the request \(([^)]+)\)/.exec(e.message)?.[1] ?? 'refused' };
    throw e instanceof UserError ? e : new UserError(`the refresh could not be completed (${e?.name ?? 'error'})`);
  }
  const rotated = { ...grant.doc, access_token: tokens.accessToken, refresh_token: tokens.refreshToken };
  if ('expires_at' in rotated) rotated.expires_at = tokens.expiresAt;
  await writeTokenFile(file, rotated);
  return { refreshed: true };
}

// --- paced search ----------------------------------------------------------------------------------------------------

// Waits for the start of the next minute, then runs `call(index)` one at a time, never starting more than `perSecond`
// calls inside any second. `call` resolves to a status string. `elapsedMs` runs from the first call's start to the end of the
// last; `withinWindow` is whether the last call started before the next minute boundary (the budget window of the first).
export async function pacedSearch({
  call, count, perSecond, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now,
}) {
  const untilBoundary = (MINUTE_MS - (now() % MINUTE_MS)) % MINUTE_MS;
  if (untilBoundary > 0) await sleep(untilBoundary);
  const starts = [];
  const results = [];
  for (let i = 0; i < count; i += 1) {
    if (i >= perSecond) {
      const wait = starts[i - perSecond] + SECOND_MS - now();
      if (wait > 0) await sleep(wait);
    }
    starts.push(now());
    results.push(await call(i));
  }
  const first = results.indexOf('rate_limited');
  const windowEnd = (Math.floor(starts[0] / MINUTE_MS) + 1) * MINUTE_MS;
  return {
    results,
    firstRateLimited: first === -1 ? null : first,
    elapsedMs: now() - starts[0],
    withinWindow: starts[starts.length - 1] < windowEnd,
  };
}

// The status of one search_skills call: the error code the tool reported, `ok`, or a transport/HTTP failure.
function searchStatus(result) {
  const code = result?.structuredContent?.error?.code;
  if (result?.isError) return typeof code === 'string' ? code : 'error';
  return 'ok';
}

// --- command line ----------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = COMMANDS[command];
  if (!flags) throw new UserError(USAGE);
  const options = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = flags[rest[i]];
    if (!key) throw new UserError(`unknown argument ${rest[i]}\n${USAGE}`);
    if (rest[i + 1] === undefined) throw new UserError(`${rest[i]} needs a value`);
    options[key] = rest[i + 1];
  }
  const missing = Object.keys(flags).filter((flag) => options[flags[flag]] === undefined && !(command === 'call' && flag === '--args'));
  if (missing.length) throw new UserError(`${missing.join(', ')} required\n${USAGE}`);
  return options;
}

function positiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UserError(`${flag} must be a positive integer`);
  return n;
}

function parseJsonArgs(text = '{}') {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new UserError('--args must be a JSON object');
}

// Exit codes: 0 done, 1 an operation reported failure (refresh refused by the issuer, a revocation failed), 2 usage or request error.
export async function main(argv, {
  fetchImpl = fetch, log = console.log, error = console.error, ports, sleep, now,
} = {}) {
  const secrets = [];
  const redact = (text) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('[redacted]'), String(text));
  try {
    const options = parseArgs(argv);
    if (options.command === 'token') {
      await mintMcpToken(options, { fetchImpl, log, ...(ports ? { ports } : {}) });
      return 0;
    }
    const grant = await readTokenFile(options.tokenFile);
    secrets.push(grant.accessToken, grant.refreshToken);
    if (options.command === 'call') {
      const result = await callTool({ url: options.url, token: grant.accessToken, tool: options.tool, args: parseJsonArgs(options.args) }, { fetchImpl });
      log(JSON.stringify(result));
      return 0;
    }
    if (options.command === 'rest') {
      log(`status ${await restStatus({ url: options.url, token: grant.accessToken, path: options.path }, { fetchImpl })}`);
      return 0;
    }
    if (options.command === 'revoke') {
      const { refresh, access } = await revokeGrant({ file: options.tokenFile }, { fetchImpl });
      log(`refresh token revoked: ${refresh}`);
      log(`access token revoked: ${access}`);
      return refresh && access ? 0 : 1;
    }
    if (options.command === 'refresh') {
      const { refreshed, code } = await tryRefresh({ file: options.tokenFile }, { fetchImpl });
      log(refreshed ? 'refresh succeeded' : `refresh failed (${code})`);
      return refreshed ? 0 : 1;
    }
    const count = positiveInt(options.count, '--count');
    const perSecond = positiveInt(options.perSecond, '--per-second');
    const {
      results, firstRateLimited, elapsedMs, withinWindow,
    } = await pacedSearch({
      count,
      perSecond,
      ...(sleep ? { sleep } : {}),
      ...(now ? { now } : {}),
      call: async () => {
        try {
          return searchStatus(await callTool({ url: options.url, token: grant.accessToken, tool: 'search_skills', args: { query: 'acceptance', k: 1 } }, { fetchImpl }));
        } catch (e) {
          return /HTTP (\d+)/.exec(e?.message ?? '')?.[0].replace(' ', '_') ?? 'failed';
        }
      },
    });
    results.forEach((status, i) => log(`index ${i}: ${status}`));
    log(`first rate_limited: ${firstRateLimited === null ? 'none' : `index ${firstRateLimited}`}`);
    log(`elapsed: ${(elapsedMs / SECOND_MS).toFixed(1)} s`);
    log(`last call started before the next minute boundary: ${withinWindow ? 'yes' : 'no'}`);
    return 0;
  } catch (e) {
    error(redact(e?.message || String(e)));
    return e instanceof UserError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
