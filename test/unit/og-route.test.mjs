// Static checks on the generated social image: Next.js builds it from app/opengraph-image.tsx, so the route's exports
// are the contract. The file is read as text, not imported, because it is TSX and pulls in next/og.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = await readFile(fileURLToPath(new URL('../../app/opengraph-image.tsx', import.meta.url)), 'utf8');

test('the social image route exports alt, size and contentType', () => {
  assert.match(source, /export const alt = ["'`][^"'`]*Headjack[^"'`]*["'`]/);
  assert.match(source, /export const size = \{ width: 1200, height: 630 \}/);
  assert.match(source, /export const contentType = 'image\/png'/);
});

test('the social image route default-exports a function that returns an ImageResponse', () => {
  assert.match(source, /import \{ ImageResponse \} from 'next\/og'/);
  assert.match(source, /export default (async )?function \w*\([^)]*\) \{[\s\S]*return new ImageResponse\(/);
});

test('the social image route loads no font file', () => {
  assert.doesNotMatch(source, /readFile|\.ttf|\.otf|\.woff/);
});
