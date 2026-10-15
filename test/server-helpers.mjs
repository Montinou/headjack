import { bearerMatches } from '../lib/auth.mjs';
import { LEGACY_OWNER_REF } from '../lib/identity.mjs';

// Test auth fixture standing in for the hosted resolver: one bearer value maps to one subject (an empty token matches
// nobody). Used only by the tests of the hosted server, so the shared helpers (test/helpers.mjs) import nothing from it.
export function bearerResolver(token, refId = LEGACY_OWNER_REF) {
  return async (req) => (bearerMatches(req, token) ? { kind: 'user', refId, via: 'test-bearer' } : null);
}
