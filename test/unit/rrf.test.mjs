import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rrf } from '../../lib/rrf.mjs';

test('fuses rankings with 1/(k+rank)', () => {
  const out = rrf([[1, 2, 3], [3, 1]]);
  assert.deepEqual(out.map((r) => r.id), [1, 3, 2]);
  assert.equal(out[0].score, 1 / 61 + 1 / 62);
  assert.equal(out[2].score, 1 / 62);
});

test('empty lists give empty result', () => {
  assert.deepEqual(rrf([[], []]), []);
});
