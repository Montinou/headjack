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

// `credential` comes from loadRemote (cli/config.mjs), which owns the not-logged-in message; `dir` is the state directory
// an OAuth credential is refreshed in. The refreshed credential replaces the one in memory for later requests. `headers` is
// a static set sent on every request (a programmatic option, never read from the environment); it cannot replace the bearer.
export function createApi({ url, credential, dir, fetchImpl = fetch, env = process.env, headers = {} }) {
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
  function init(token, extra = {}) {
    return {
      ...extra,
      headers: {
        ...common,
        ...headers,
        authorization: `Bearer ${token}`,
        ...(extra.headers ?? {}),
      },
    };
  }
  async function send(pathname, extra, token) {
    try {
      return await fetchImpl(url + pathname, init(token, extra));
    } catch (e) {
      throw new ApiError(0, 'network', `could not connect to ${url}: ${e.message}`);
    }
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
      try { body = await res.json(); } catch {}
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
      return (await (await call(`/api/search?${params}`, { headers: { 'x-headjack-purpose': purpose } })).json()).results;
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
        return (await (await call(`/api/skills/${enc(slug)}`)).json()).skill;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    async download(slug) {
      const res = await call(`/api/skills/${enc(slug)}/download`);
      return { sha256: res.headers.get('x-skill-sha256'), tarball: Buffer.from(await res.arrayBuffer()) };
    },
    async versions(slug) {
      return (await (await call(`/api/skills/${enc(slug)}/versions`)).json()).versions;
    },
    async reviews(slug) {
      return (await (await call(`/api/skills/${enc(slug)}/reviews`)).json()).reviews;
    },
    async publish(manifest, tarball) {
      const form = new FormData();
      form.set('manifest', JSON.stringify(manifest));
      if (tarball) form.set('tarball', new Blob([tarball], { type: 'application/gzip' }), `${manifest.slug}.tgz`);
      return (await call('/api/skills', { method: 'POST', body: form })).json();
    },
    async updates(grandfathered = false) {
      return (await (await call(`/api/updates${grandfathered ? '?grandfathered=1' : ''}`)).json()).updates;
    },
  };
}
