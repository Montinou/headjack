import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
const secret = 'fixture-' + 'cursor-secret-at-least-32-bytes';
const binding = { ownerId: 7, tag: 'web', kind: 'skill' };
const load = () => import('../../lib/mcp/cursor.mjs');

test('cursor round-trips canonical base64url JSON bound to owner and filters', async () => {
  const { encodeCursor, decodeCursor } = await load();
  const cursor = encodeCursor({ ...binding, lastSlug: 'mañana' }, secret);
  assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(cursor, binding, secret), { lastSlug: 'mañana' });
  assert.equal(Buffer.from(cursor.split('.')[0], 'base64url').toString(), '{"version":1,"ownerId":7,"lastSlug":"mañana","tag":"web","kind":"skill"}');
});

test('cursor rejects foreign owner, changed filters, secret and tampering', async () => {
  const { encodeCursor, decodeCursor } = await load();
  const cursor = encodeCursor({ ...binding, lastSlug: 'x' }, secret);
  for (const other of [{ ...binding, ownerId: 8 }, { ...binding, tag: null }, { ...binding, kind: 'plugin' }]) {
    assert.throws(() => decodeCursor(cursor, other, secret), { code: 'invalid_input' });
  }
  assert.throws(() => decodeCursor(cursor, binding, 'different'), { code: 'invalid_input' });
  assert.throws(() => decodeCursor(`A${cursor.slice(1)}`, binding, secret), { code: 'invalid_input' });
});

test('cursor rejects malformed, oversized, noncanonical and wrong-version signed payloads', async () => {
  const { decodeCursor } = await load();
  const signed = (json) => {
    const body = Buffer.from(json).toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  for (const cursor of ['', 'x.y', 'x'.repeat(2049), signed('{"version":2,"ownerId":7,"lastSlug":"x","tag":"web","kind":"skill"}'), signed('{ "version":1,"ownerId":7,"lastSlug":"x","tag":"web","kind":"skill"}'), signed('{"version":1,"ownerId":7,"lastSlug":"","tag":"web","kind":"skill"}'), signed('{"version":1,"ownerId":7,"lastSlug":"x","tag":"web","kind":"skill","extra":true}')]) {
    assert.throws(() => decodeCursor(cursor, binding, secret), { code: 'invalid_input' });
  }
});

test('cursor normalizes omitted filters and caps encoding size', async () => {
  const { encodeCursor, decodeCursor } = await load();
  const cursor = encodeCursor({ ownerId: 7, lastSlug: 'x' }, secret);
  assert.deepEqual(decodeCursor(cursor, { ownerId: 7, tag: null, kind: null }, secret), { lastSlug: 'x' });
  assert.throws(() => encodeCursor({ ownerId: 7, lastSlug: 'x'.repeat(2000) }, secret), { code: 'invalid_input' });
});
