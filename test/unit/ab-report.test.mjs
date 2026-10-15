import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportLines } from '../../scripts/ab-report.mjs';

test('reportLines prints exposures, conversions and rate per variant, rate 0 without exposures', () => {
  assert.deepEqual(reportLines([
    { variant: 'rrf-bilingual', exposures: 8, conversions: 1 },
    { variant: 'rrf-english', exposures: 0, conversions: 0 },
  ]), [
    'rrf-bilingual: 8 exposures · 1 conversions · rate 12.5%',
    'rrf-english: 0 exposures · 0 conversions · rate 0.0%',
  ]);
});

test('reportLines says so when there are no exposures at all', () => {
  assert.deepEqual(reportLines([]), ['no exposures recorded']);
});
