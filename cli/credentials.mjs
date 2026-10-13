import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../lib/errors.mjs';
import { authServerMetadata, refreshTokens } from './oauth.mjs';

// The CLI credential in `<state dir>/token`: a raw API key (the original format) or an OAuth credential stored as JSON
// with snake_case keys. Writes are atomic (a mode 600 temporary file in the same directory, then rename) and refreshes
// are serialized across processes by `<state dir>/token.lock`, because the issuer rotates the refresh token: a second
// process refreshing with the old one would lose the login. No message ever carries a token.

const REFRESH_WINDOW_MS = 60000;
const LOCK_POLL_MS = 100;
const SESSION_EXPIRED = 'session expired: run headjack login';
const STRING_FIELDS = ['issuer', 'client_id', 'resource', 'email', 'access_token', 'refresh_token'];

export const tokenFile = (dir) => path.join(dir, 'token');
const invalidCredential = (file) => new UserError(`${file} is not a valid credential; run headjack login --force`);

function parseOAuth(text, file) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw invalidCredential(file); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.kind !== 'oauth'
    || STRING_FIELDS.some((key) => typeof doc[key] !== 'string' || !doc[key])
    || !Number.isFinite(doc.expires_at)) {
    throw invalidCredential(file);
  }
  return {
    kind: 'oauth',
    source: 'file',
    issuer: doc.issuer,
    clientId: doc.client_id,
    resource: doc.resource,
    email: doc.email,
    accessToken: doc.access_token,
    refreshToken: doc.refresh_token,
    expiresAt: doc.expires_at,
  };
}

// The file alone, ignoring HEADJACK_TOKEN: what a refresh must re-read under the lock.
async function readFileCredential(dir) {
  const file = tokenFile(dir);
  let st;
  try { st = await stat(file); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (st.mode & 0o077) throw new UserError(`${file} has mode ${(st.mode & 0o777).toString(8)}; run: chmod 600 ${file}`);
  const text = (await readFile(file, 'utf8')).trim();
  if (!text) throw invalidCredential(file);
  if (text.startsWith('{')) return parseOAuth(text, file);
  return { kind: 'api-key', token: text, source: 'file' };
}

export async function readCredential({ env = process.env, dir }) {
  if (env.HEADJACK_TOKEN) return { kind: 'api-key', token: env.HEADJACK_TOKEN, source: 'env' };
  return readFileCredential(dir);
}

export async function writeOAuthCredential(dir, credential) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = {
    kind: 'oauth',
    issuer: credential.issuer,
    client_id: credential.clientId,
    resource: credential.resource,
    email: credential.email,
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    expires_at: credential.expiresAt,
  };
  const tmp = path.join(dir, `token.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    // Created with mode 600 from the start, so the token is never readable by others, not even briefly.
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(body)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, tokenFile(dir));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// A file's identity: device and inode, plus mtime because an inode number can be reused once a lock is deleted (a rename
// keeps the mtime).
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Removes a lock left by a crashed process. It is moved aside first and checked to be the very file judged stale, so two
// processes taking over the same stale lock at once do not delete each other's fresh lock: a fresh lock moved aside by
// mistake is linked back. That repair fails if a third process creates a lock in the instant between the move and the
// link; then two processes believe they hold the lock, which only an OS-level lock could rule out.
async function takeOverStaleLock(file, staleStat) {
  const aside = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
  try { await rename(file, aside); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const moved = await stat(aside);
  if (!sameFile(moved, staleStat)) await link(aside, file).catch(() => {});
  await unlink(aside).catch(() => {});
}

export async function withCredentialLock(dir, fn, { staleMs = 30000, waitMs = 15000 } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'token.lock');
  const deadline = Date.now() + waitMs;
  let own;
  for (;;) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (handle) {
      try {
        try {
          await handle.writeFile(`${process.pid}\n`);
          own = await handle.stat();
        } finally {
          await handle.close();
        }
      } catch (e) {
        // The lock exists but could not be completed: remove it now instead of blocking everyone until it goes stale.
        await unlink(file).catch(() => {});
        throw e;
      }
      break;
    }
    const held = await stat(file).catch(() => null);
    if (!held) continue; // released between the two calls
    if (Date.now() - held.mtimeMs > staleMs) {
      await takeOverStaleLock(file, held);
      continue;
    }
    if (Date.now() >= deadline) throw new UserError('another headjack process is refreshing the login');
    await sleep(Math.min(LOCK_POLL_MS, deadline - Date.now()));
  }
  try {
    return await fn();
  } finally {
    // Only our own lock is removed: if it was taken over meanwhile, the file now belongs to someone else.
    const current = await stat(file).catch(() => null);
    if (current && sameFile(current, own)) await unlink(file).catch(() => {});
  }
}

const isFresh = (credential, now) => credential.expiresAt - now() > REFRESH_WINDOW_MS;
const sameLogin = (a, b) => a.issuer === b.issuer && a.clientId === b.clientId && a.resource === b.resource;

// Network calls under the lock are bounded (`timeoutMs`, default 10 s) and discovery runs before it, so a holder always
// finishes well inside the 30 s after which its lock counts as stale and another process may take it over.
export async function freshCredential({ dir, credential, rejectedToken = null }, { fetchImpl = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  if (rejectedToken === null && isFresh(credential, now)) return credential;
  // The lock only proceeds with a stored credential of the same issuer, so its endpoint can be found before locking.
  const { tokenEndpoint } = await authServerMetadata(credential.issuer, { fetchImpl, timeoutMs });
  return withCredentialLock(dir, async () => {
    const stored = await readFileCredential(dir);
    // A logout or another login replaced the file meanwhile: refreshing would bring back a credential the user dropped.
    if (stored?.kind !== 'oauth' || !sameLogin(stored, credential)) throw new UserError(SESSION_EXPIRED);
    const stale = rejectedToken ?? credential.accessToken;
    if (isFresh(stored, now) && stored.accessToken !== stale) return stored;
    let tokens;
    try {
      // The stored refresh token, not the one in memory: another process may have rotated it.
      tokens = await refreshTokens({
        tokenEndpoint, clientId: stored.clientId, refreshToken: stored.refreshToken, resource: stored.resource,
      }, { fetchImpl, timeoutMs });
    } catch (e) {
      // Only the issuer refusing the refresh token ends the session; an unreachable or failing issuer keeps its own line.
      if (e instanceof UserError && e.oauthRefusal) throw new UserError(SESSION_EXPIRED, { cause: e });
      throw e;
    }
    const refreshed = { ...stored, ...tokens };
    try {
      await writeOAuthCredential(dir, refreshed);
    } catch (e) {
      // The issuer has already rotated the refresh token, so this login is lost; say where, in one line.
      throw new UserError(`could not save the refreshed login to ${tokenFile(dir)}; run headjack login`, { cause: e });
    }
    return refreshed;
  });
}
