import { createHmac, timingSafeEqual } from 'node:crypto';
import { MCP_LIMITS } from './config.mjs';

const invalid = () => Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
const canonical = ({ ownerId, lastSlug, tag = null, kind = null }) => ({ version: 1, ownerId, lastSlug, tag, kind });
const sign = (body, secret) => createHmac('sha256', secret).update(body).digest();
function validate(payload) {
  if (!Number.isSafeInteger(payload.ownerId) || payload.ownerId <= 0
    || typeof payload.lastSlug !== 'string' || !payload.lastSlug.trim() || payload.lastSlug.length > MCP_LIMITS.slugChars
    || !(payload.tag === null || (typeof payload.tag === 'string' && payload.tag.length <= MCP_LIMITS.tagChars))
    || ![null, 'skill', 'plugin'].includes(payload.kind)) throw invalid();
}

export function encodeCursor(input, secret) {
  const payload = canonical(input);
  validate(payload);
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const cursor = `${body}.${sign(body, secret).toString('base64url')}`;
  if (Buffer.byteLength(cursor) > MCP_LIMITS.cursorBytes) throw invalid();
  return cursor;
}

export function decodeCursor(cursor, { ownerId, tag = null, kind = null }, secret) {
  try {
    if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > MCP_LIMITS.cursorBytes
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
    const [body, signature] = cursor.split('.');
    const supplied = Buffer.from(signature, 'base64url');
    const expected = sign(body, secret);
    if (supplied.length !== expected.length || supplied.toString('base64url') !== signature
      || !timingSafeEqual(supplied, expected)) throw invalid();
    const raw = Buffer.from(body, 'base64url');
    if (raw.toString('base64url') !== body) throw invalid();
    const payload = JSON.parse(raw.toString('utf8'));
    validate(payload);
    if (payload.version !== 1 || JSON.stringify(canonical(payload)) !== raw.toString('utf8')
      || payload.ownerId !== ownerId || payload.tag !== tag || payload.kind !== kind) throw invalid();
    return { lastSlug: payload.lastSlug };
  } catch {
    throw invalid();
  }
}
