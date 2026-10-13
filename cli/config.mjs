import { UserError } from '../lib/errors.mjs';
import { canonicalUrl, isSecureUrl } from '../lib/oauth-config.mjs';
import { readCredential } from './credentials.mjs';

// 'local' (the SQLite vault in the state directory) or 'remote' (the hosted server). HEADJACK_MODE decides when set;
// otherwise HEADJACK_URL selects remote and its absence selects local. Hosted-mode commands never reach local code.
export function resolveMode(env = process.env) {
  const mode = env.HEADJACK_MODE;
  if (mode) {
    if (mode !== 'local' && mode !== 'remote') throw new UserError('HEADJACK_MODE must be local or remote');
    return mode;
  }
  return env.HEADJACK_URL ? 'remote' : 'local';
}

// HEADJACK_URL in canonical form (lowercase host, no default port, no trailing slash; a path is kept), so every spelling of
// one server behaves alike. login, logout and whoami need only this, never a credential. Bearer tokens travel to it, so it
// is https, or http on a loopback host, with no credentials, query or fragment; the message never
// echoes the value (it may carry credentials).
export function loadUrl(env = process.env) {
  const raw = env.HEADJACK_URL;
  if (!raw) throw new UserError('HEADJACK_URL is not set (for example https://headjack.example.invalid)');
  let url = null;
  let plain = true;
  try {
    const parsed = new URL(raw);
    if (isSecureUrl(parsed)) {
      plain = !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
      if (plain) url = canonicalUrl(raw);
    }
  } catch {}
  if (!plain) throw new UserError('HEADJACK_URL must be a plain https origin (or http on loopback) without credentials, query or fragment');
  if (!url) throw new UserError('HEADJACK_URL must be an https URL (http is allowed only for localhost, 127.0.0.1 and [::1])');
  return url;
}

// The credential comes from HEADJACK_TOKEN or the state directory's token file (`dir`, see stateDir in local-config.mjs).
export async function loadRemote({ env = process.env, dir }) {
  const url = loadUrl(env);
  const credential = await readCredential({ env, dir });
  if (!credential) throw new UserError('not logged in: run headjack login, or set HEADJACK_TOKEN (an API key)');
  return { url, credential };
}
