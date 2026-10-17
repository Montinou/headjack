import { UserError } from '../lib/errors.mjs';
import { isApiResourceOf } from '../lib/oauth-config.mjs';
import { freshCredential } from './credentials.mjs';

// Hosted servers commonly reject request bodies over 4.5 MB; refuse bigger tarballs before uploading.
export const MAX_TARBALL_BYTES = 4 * 1024 * 1024;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

// A body that passed the limit the caller set: status 0 like any answer the client could not use, a fixed code to tell it apart.
const tooLarge = () => new ApiError(0, 'too_large', 'the response is larger than allowed');

// The body of `res` as a Buffer. Without `max` it is read whole, as ever. With one, a declared length over it is refused before
// a byte is read, and a body that grows past it (no length, or a length that lied) stops being read: the reader is cancelled,
// which drops the connection, so a server cannot make this process buffer more than `max` plus one chunk.
async function readBody(res, max) {
  if (max === undefined) return Buffer.from(await res.arrayBuffer());
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

// `credential` comes from loadRemote (cli/config.mjs), which owns the not-logged-in message; `dir` is the state directory
// an OAuth credential is refreshed in. The refreshed credential replaces the one in memory for later requests. `headers` is
// a static set sent on every request (a programmatic option, never read from the environment); it cannot replace the bearer.
// `maxBodyBytes`, when given, bounds every JSON answer (and error body) the client parses: a longer one is a `too_large` ApiError
// (or, for an error body, ignored). Without it nothing is bounded, which is what the CLI wants.
export function createApi({ url, credential, dir, fetchImpl = fetch, env = process.env, headers = {}, maxBodyBytes }) {
  if (credential.kind === 'oauth' && !isApiResourceOf(credential.resource, url)) {
    throw new UserError('the saved login is for another server: run headjack login --force');
  }
  let current = credential;
  // Sent on every request; an invalid session id is dropped rather than sent empty.
  const common = {};
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (typeof session === 'string' && SESSION_ID.test(session)) common['x-headjack-session'] = session;

  // The bearer for the next request. A rejected token forces a refresh of an OAuth credential.
  async function bearer(rejectedToken = null) {
    if (current.kind !== 'oauth') return current.token;
    current = await freshCredential({ dir, credential: current, rejectedToken }, { fetchImpl });
    return current.accessToken;
  }
  // A per-request header set to null is removed: how one request drops a header from `common`.
  function init(token, extra = {}) {
    const merged = {
      ...common,
      ...headers,
      authorization: `Bearer ${token}`,
      ...(extra.headers ?? {}),
    };
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
    return { ...extra, headers: merged };
  }
  async function send(pathname, extra, token) {
    try {
      return await fetchImpl(url + pathname, init(token, extra));
    } catch (e) {
      throw new ApiError(0, 'network', `could not connect to ${url}: ${e.message}`);
    }
  }
  // The parsed JSON body of `res`.
  async function json(res) {
    if (maxBodyBytes === undefined) return res.json();
    return JSON.parse(new TextDecoder().decode(await readBody(res, maxBodyBytes)));
  }
  async function call(pathname, extra = {}) {
    let token = await bearer();
    let res = await send(pathname, extra, token);
    if (res.status === 401 && current.kind === 'oauth') {
      await res.body?.cancel();
      token = await bearer(token);
      res = await send(pathname, extra, token);
    }
    if (!res.ok) {
      let body = {};
      try { body = await json(res); } catch {}
      const message = body.error?.message ?? `HTTP ${res.status}`;
      const hint = current.kind === 'api-key' && current.source === 'env' ? 'check HEADJACK_TOKEN' : 'run headjack login';
      throw new ApiError(res.status, body.error?.code ?? 'http_error', res.status === 401 ? `${message}: ${hint}` : message);
    }
    return res;
  }
  const enc = encodeURIComponent;
  return {
    async search(q, k = 8, kind, tags = [], purpose = 'manual') {
      const params = new URLSearchParams({ q, k: String(k) });
      if (kind) params.set('kind', kind);
      if (tags.length) params.set('tag', tags.join(','));
      return (await json(await call(`/api/search?${params}`, { headers: { 'x-headjack-purpose': purpose } }))).results;
    },
    // POST /api/search for the suggestion pipeline: `q` travels in the JSON body, never in the URL (a prompt must not land in
    // access logs). `sessionId` is authoritative: valid, it is sent; invalid, it is dropped along with the ambient
    // CLAUDE_CODE_SESSION_ID header. `signal` aborts the request and also settles this call at once, even while a token refresh
    // (which takes no signal) is still running.
    async searchPost(q, k = 5, { purpose = 'manual', sessionId, signal } = {}) {
      signal?.throwIfAborted();
      const headers = { 'content-type': 'application/json', 'x-headjack-purpose': purpose };
      if (sessionId !== undefined) headers['x-headjack-session'] = typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? sessionId : null;
      const request = (async () => {
        const res = await call('/api/search', { method: 'POST', headers, body: JSON.stringify({ q, k }), signal });
        return (await json(res)).results;
      })();
      if (!signal) return request;
      request.catch(() => {}); // the race below may settle first; the late outcome is not an unhandled rejection
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([request, aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    // The catalog page of GET /api/skills (the handler caps `limit` at 100). `tag`: one tag or a list, all required.
    async list({ kind, tag, limit = 50, offset = 0 } = {}) {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      const tags = [tag ?? []].flat();
      if (tags.length) params.set('tag', tags.join(','));
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      return json(await call(`/api/skills?${params}`));
    },
    // Advisory: any failure, non-2xx or timeout resolves undefined so it never changes the caller's outcome.
    async installEvent({ slug, kind, source }, { timeoutMs = 3000 } = {}) {
      const signal = AbortSignal.timeout(timeoutMs);
      const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      try {
        const res = await Promise.race([
          (async () => {
            const token = await bearer();
            return fetchImpl(`${url}/api/events/install`, init(token, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ slug, kind, source }),
              signal,
            }));
          })(),
          aborted,
        ]);
        await res?.body?.cancel();
      } catch {}
    },
    async getSkill(slug) {
      try {
        return (await json(await call(`/api/skills/${enc(slug)}`))).skill;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    // `maxBytes`, when given, caps the archive: a longer one is a `too_large` ApiError, refused from its declared length or as soon
    // as the bytes read pass the cap. Without it the whole body is read.
    async download(slug, { maxBytes } = {}) {
      const res = await call(`/api/skills/${enc(slug)}/download`);
      return { sha256: res.headers.get('x-skill-sha256'), tarball: await readBody(res, maxBytes) };
    },
    async versions(slug) {
      return (await json(await call(`/api/skills/${enc(slug)}/versions`))).versions;
    },
    async reviews(slug) {
      return (await json(await call(`/api/skills/${enc(slug)}/reviews`))).reviews;
    },
    async publish(manifest, tarball) {
      const form = new FormData();
      form.set('manifest', JSON.stringify(manifest));
      if (tarball) form.set('tarball', new Blob([tarball], { type: 'application/gzip' }), `${manifest.slug}.tgz`);
      return json(await call('/api/skills', { method: 'POST', body: form }));
    },
    async updates(grandfathered = false) {
      return (await json(await call(`/api/updates${grandfathered ? '?grandfathered=1' : ''}`))).updates;
    },
  };
}
