import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewOf } from '../../lib/review-status.mjs';

test('reviewOf marks the importer notes as unreviewed', () => {
  assert.equal(reviewOf('grandfathered: installed before the vault, not reviewed'), 'unreviewed');
  assert.equal(reviewOf('plugin: enabled through enabledPlugins; content managed by its marketplace'), 'unreviewed');
  assert.equal(reviewOf('plugin skill: activated by enabling the plugin'), 'unreviewed');
});

test('reviewOf is case-sensitive and treats everything else as approved', () => {
  assert.equal(reviewOf('Grandfathered: x'), 'approved');
  assert.equal(reviewOf(null), 'approved');
  assert.equal(reviewOf(undefined), 'approved');
  assert.equal(reviewOf('looks fine'), 'approved');
});
