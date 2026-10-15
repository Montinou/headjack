import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Pool } from '@neondatabase/serverless';
import { describeUrl, withOwnerRole } from '../../db/owner.mjs';

test('describeUrl gives user@host/db and never the password, even for a malformed URL', () => {
  assert.equal(describeUrl('postgresql://someone:s3cret-pw' + '@ep-x.neon.tech/neondb?sslmode=require'), 'someone' + '@ep-x.neon.tech/neondb');
  // new URL() throws on this one and its TypeError carries the whole input, password included.
  const seen = (() => {
    try { return describeUrl('postgresql://someone:s3cret-pw' + '@ep x.neon.tech/neondb'); } catch (e) { return inspect(e); }
  })();
  assert.doesNotMatch(seen, /s3cret-pw/);
  assert.equal(seen, '<unparseable DATABASE_URL_OWNER>');
});

test('withOwnerRole ends its pool and rethrows the connection error when connecting fails', async (t) => {
  let ended = 0;
  t.mock.method(Pool.prototype, 'connect', async () => { throw new Error('connect refused'); });
  t.mock.method(Pool.prototype, 'end', async () => { ended += 1; });
  await assert.rejects(withOwnerRole({ DATABASE_URL_OWNER: 'postgresql://u:pw' + '@127.0.0.1:1/db' }, async () => 'unreached'), /connect refused/);
  assert.equal(ended, 1, 'the pool is ended even though no client was ever checked out');
});
