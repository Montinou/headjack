import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteUrl } from '../../lib/site-url.mjs';

test('siteUrl uses the production URL Vercel provides', () => {
  assert.equal(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'headjack.example.invalid' }).href, 'https://headjack.example.invalid/');
});

test('siteUrl falls back to localhost on the configured port, like Next.js', () => {
  assert.equal(siteUrl({ PORT: '4123' }).href, 'http://localhost:4123/');
  assert.equal(siteUrl({}).href, 'http://localhost:3000/');
  assert.equal(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: '' }).href, 'http://localhost:3000/');
});
