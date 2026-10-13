// The local-mode api: the hosted handlers (lib/handlers.mjs) over the SQLite vault, reached through an in-process
// `fetch` handed to the unchanged createApi (cli/api.mjs). No network, no auth: the vault has one implicit owner.
import { ApiError, createApi } from '../../cli/api.mjs';
import { createHandlers } from '../handlers.mjs';
import { runtimeCheck } from './runtime.mjs';
import { damagedMessage, isBusy, isDamaged, openVault } from './schema.mjs';
import { createSqliteRepo } from './sqlite-repo.mjs';
import { checkLocalUpdates, ttlHoursFrom } from './updates.mjs';

export const LOCAL_URL = 'http://headjack.local';
const OWNER_ID = 1;

const busy = () =>
  new Response(JSON.stringify({ error: { code: 'unavailable', message: 'vault is busy, try again' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
const damaged = (dir) =>
  new Response(JSON.stringify({ error: { code: 'vault_damaged', message: damagedMessage(dir) } }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });
const notFound = () =>
  new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

// `upstreamFetch`, `env` (GITHUB_TOKEN, HEADJACK_UPDATE_TTL_HOURS) and `now` drive the upstream-update check behind
// `api.updates()`; `wrapRepo` lets tests wrap the repository.
export async function createLocalApi({ dir, env = process.env, upstreamFetch = fetch, wrapRepo = (r) => r, now = Date.now }) {
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync });
  // Idempotent. Anything that throws after the vault opened closes it, so a failed build leaves no open handle.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  try {
    const repo = createSqliteRepo(db);
    const handlers = createHandlers({
      identify: async () => ({ ownerId: OWNER_ID }),
      repoFor: () => wrapRepo(repo),
      env: {},
      log: () => {},
      mapError: (e) => (isBusy(e) ? busy() : isDamaged(e) ? damaged(dir) : null),
    });

    // The nine routes createApi calls; anything else is a 404.
    async function route(url, init = {}) {
      const req = new Request(url, init);
      const method = req.method;
      const parts = new URL(req.url).pathname.split('/'); // ['', 'api', 'skills', slug, sub]
      let handler = null;
      if (parts[1] === 'api') {
        const [, , area, , sub] = parts;
        if (parts.length === 3 && area === 'search' && method === 'GET') handler = handlers.search;
        else if (parts.length === 3 && area === 'skills' && method === 'GET') handler = handlers.listSkills;
        else if (parts.length === 3 && area === 'skills' && method === 'POST') handler = handlers.publish;
        else if (parts.length === 3 && area === 'updates' && method === 'GET') handler = handlers.updates;
        else if (area === 'events' && parts.length === 4 && parts[3] === 'install' && method === 'POST') handler = handlers.installEvent;
        else if (area === 'skills' && method === 'GET' && parts[3]) {
          if (parts.length === 4) handler = handlers.getSkill;
          else if (parts.length === 5 && sub === 'download') handler = handlers.download;
          else if (parts.length === 5 && sub === 'versions') handler = handlers.versions;
          else if (parts.length === 5 && sub === 'reviews') handler = handlers.reviews;
        }
      }
      return handler ? handler(req) : notFound();
    }

    const hostedApi = createApi({
      url: LOCAL_URL,
      credential: { kind: 'api-key', token: 'local' },
      dir,
      fetchImpl: route,
      env,
    });
    // Refresh stale upstream checks before listing updates; the grandfathered list needs no network.
    const api = {
      ...hostedApi,
      async updates(grandfathered = false) {
        if (!grandfathered) {
          try {
            await checkLocalUpdates({
              repo,
              fetchImpl: upstreamFetch,
              githubToken: env.GITHUB_TOKEN,
              ttlHours: ttlHoursFrom(env.HEADJACK_UPDATE_TTL_HOURS),
              now,
            });
          } catch (e) {
            // The same answers the router gives a busy vault (CLI exit 3) and a damaged one (exit 2).
            if (isBusy(e)) throw new ApiError(503, 'unavailable', 'vault is busy, try again');
            if (isDamaged(e)) throw new ApiError(422, 'vault_damaged', damagedMessage(dir));
            throw e;
          }
        }
        return hostedApi.updates(grandfathered);
      },
    };
    return { api, repo, route, close };
  } catch (e) {
    close();
    throw e;
  }
}
