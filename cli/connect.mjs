// The one way a client reaches the api: the hosted server over HTTP, or the local SQLite vault in process. The CLI and the
// MCP server both open it here, so they resolve the mode, the credential and the state-directory errors the same way.
import { access } from 'node:fs/promises';
import { UserError } from '../lib/errors.mjs';
import { ApiError, createApi } from './api.mjs';
import { loadRemote, resolveMode } from './config.mjs';
import { tokenFile } from './credentials.mjs';

// Local mode only: lib/local is imported here, never for a hosted command, so hosted mode never loads the SQLite module. A
// state directory that cannot be created, opened or written is one line naming it; a busy vault is a 503 ApiError.
export async function guardLocal(dir, open) {
  const { isBusy } = await import('../lib/local/schema.mjs');
  try {
    return await open();
  } catch (e) {
    if (isBusy(e)) throw new ApiError(503, 'unavailable', 'vault is busy, try again');
    if (e instanceof UserError || typeof e?.code !== 'string' || !(/^E[A-Z0-9]+$/.test(e.code) || e.code === 'ERR_SQLITE_ERROR')) throw e;
    throw new UserError(`cannot use the state directory ${dir} (${e.code === 'ERR_SQLITE_ERROR' ? e.message : e.code})`);
  }
}

// `ctx.dir` is the state directory. `env` picks the mode (HEADJACK_MODE, else HEADJACK_URL), `log` carries the implicit-local
// warning, `fetchImpl` and `maxBodyBytes` (a limit on every JSON answer, see createApi) go to the hosted api only. `close` is a
// no-op for hosted mode and idempotent for the local vault.
export async function openApi(ctx, { env = process.env, log = console.error, fetchImpl, maxBodyBytes } = {}) {
  if (resolveMode(env) !== 'local') {
    return { api: createApi({ ...(await loadRemote({ env, dir: ctx.dir })), dir: ctx.dir, env, fetchImpl, maxBodyBytes }), close: () => {} };
  }
  // A hosted user who lost HEADJACK_URL (a new shell, a cleared env) would otherwise search an empty local vault unaware.
  // Only an implicit local mode with a saved login says so; HEADJACK_MODE=local is the user's explicit choice.
  if (!env.HEADJACK_MODE && (await access(tokenFile(ctx.dir)).then(() => true, () => false))) {
    log('headjack: HEADJACK_URL is not set, using the local vault; set HEADJACK_URL (or HEADJACK_MODE=remote) to use your hosted vault');
  }
  const { createLocalApi } = await import('../lib/local/api.mjs');
  const { api, close } = await guardLocal(ctx.dir, () => createLocalApi({ dir: ctx.dir, env }));
  return { api, close };
}
