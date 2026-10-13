import { createHash, timingSafeEqual } from 'node:crypto';

export function bearerMatches(req, expected) {
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  const got = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
