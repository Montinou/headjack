// The hosted search adapter of the suggestion pipeline (spec §3.3, §6.1): POST /api/search, the prompt in the body and
// never in the URL. No npm dependencies.
import { ApiError, createApi } from '../cli/api.mjs';
import { loadRemote, loadUrl } from '../cli/config.mjs';
import { UserError } from './errors.mjs';

const K = 5;
// The answer to five results is a few KB; the cap keeps the per-prompt hook from parsing an unbounded body.
const MAX_BODY_BYTES = 256 * 1024;

// Whether the circuit breaker (spec §4, "deadline timeouts, network errors and HTTP 5xx") counts this error. Usage errors
// do not count: a UserError (a bad HEADJACK_URL, not logged in) and a 4xx answer (401 and 403 included: the user can fix
// them, and retrying cannot help) are `failure: false`. Everything else is `failure: true`: 5xx, a connection error
// (ApiError status 0), an aborted deadline, a malformed answer.
function classify(error, signal) {
  const expected = error instanceof UserError || (error instanceof ApiError && error.status >= 400 && error.status < 500);
  const failure = signal?.aborted ? true : !expected;
  const err = error instanceof Error ? error : new Error('search failed');
  err.failure = failure;
  return err;
}

// hostedSearch({ env, dir, config, query, purpose, sessionId, signal, fetchImpl }) resolves to
// { candidates, variant } (variant from the first result, null when absent), or to { outcome } when skipped:
// 'skipped:no-url' (neither HEADJACK_URL nor config.suggest.url) or 'skipped:no-post' (the server answers POST with
// 404 or 405). The URL comes from HEADJACK_URL, else suggest.url, whatever HEADJACK_MODE says. Any other error rejects
// with `failure` set as classify describes. The error message never carries the query.
export async function hostedSearch({ env, dir, config, query, purpose, sessionId, signal, fetchImpl = fetch }) {
  const url = env.HEADJACK_URL || config?.suggest?.url;
  if (!url) return { outcome: 'skipped:no-url' };
  try {
    if (!env.HEADJACK_URL) {
      // The URL is suggest.url: its validation errors name that key, not HEADJACK_URL.
      try { loadUrl({ HEADJACK_URL: url }); } catch (e) {
        throw e instanceof UserError ? new UserError(e.message.replaceAll('HEADJACK_URL', 'suggest.url'), { cause: e }) : e;
      }
    }
    const remote = await loadRemote({ env: { ...env, HEADJACK_URL: url }, dir });
    // The session id is passed explicitly: the ambient CLAUDE_CODE_SESSION_ID is not this call's to send.
    const api = createApi({ ...remote, dir, fetchImpl, env: { ...env, CLAUDE_CODE_SESSION_ID: undefined }, maxBodyBytes: MAX_BODY_BYTES });
    const results = await api.searchPost(query, K, { purpose, sessionId, signal });
    if (!Array.isArray(results)) throw new Error('malformed search response');
    return { candidates: results, variant: results[0]?.variant ?? null };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return { outcome: 'skipped:no-post' };
    throw classify(e, signal);
  }
}
