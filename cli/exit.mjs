import { UserError } from '../lib/errors.mjs';
import { ApiError } from './api.mjs';

// 3 = transient (network or 5xx) so callers can tell it from their own mistakes (2); 1 = unexpected.
export function exitCodeFor(error) {
  if (error == null) return 0;
  if (error instanceof ApiError) return error.status === 0 || error.status >= 500 ? 3 : 2;
  if (error instanceof UserError) return 2;
  return 1;
}
