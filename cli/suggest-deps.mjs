// The dependencies of the suggestion pipeline that `headjack suggest` and the prompt hook share (spec §3.3): the search
// follows suggest.hosted only, never HEADJACK_MODE or HEADJACK_URL; the active state and the session store are the CLI's.
import { activeKeys } from './active.mjs';
import { localSearch } from '../lib/suggest-local.mjs';
import { hostedSearch } from '../lib/suggest-hosted.mjs';
import { sessionStore } from '../lib/suggest-session.mjs';

// ctx: { env, dir, home, cwd }. `migrate` is for the manual entry only (the prompt path never migrates); `signal` aborts a
// hosted call; `adapters` replaces the two search adapters (tests).
export function suggestDeps({ ctx, config, sessionId, migrate = false, signal, adapters = {} }) {
  const local = adapters.localSearch ?? localSearch;
  const hosted = adapters.hostedSearch ?? hostedSearch;
  return {
    search: (query, mode) => (mode === 'hosted'
      ? hosted({ env: ctx.env, dir: ctx.dir, config, query, purpose: 'suggest', sessionId, signal })
      : local({ dir: ctx.dir, query, migrate })),
    activeKeys: () => activeKeys(ctx),
    sessionStore: sessionStore(ctx.dir),
  };
}
