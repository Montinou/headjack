// toVaultSlug (spec §5.2): the Skill tool's name -> the vault slug it denotes, or null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVaultSlug } from '../../lib/skill-name.mjs';

const ctx = (slugs, enabledPlugins = {}) => ({ slugs: new Set(slugs), enabledPlugins });

test('a bare name maps to the vault slug equal to it', () => {
  assert.equal(toVaultSlug('humanizer', ctx(['humanizer', 'other'])), 'humanizer');
});

test('<plugin>:<skill> with one marketplace maps to it, enabled or not', () => {
  assert.equal(toVaultSlug('vercel:flags-sdk', ctx(['vercel@m:flags-sdk'])), 'vercel@m:flags-sdk');
});

test('several marketplaces: the one enabled in enabledPlugins wins', () => {
  const slugs = ['vercel@a:flags-sdk', 'vercel@b:flags-sdk'];
  assert.equal(toVaultSlug('vercel:flags-sdk', ctx(slugs, { 'vercel@b': true, 'vercel@a': false })), 'vercel@b:flags-sdk');
  assert.equal(toVaultSlug('vercel:flags-sdk', ctx(slugs, { 'vercel@b': true })), 'vercel@b:flags-sdk');
});

test('several marketplaces: both enabled, or neither, is ambiguous and unmapped', () => {
  const slugs = ['vercel@a:flags-sdk', 'vercel@b:flags-sdk'];
  assert.equal(toVaultSlug('vercel:flags-sdk', ctx(slugs, { 'vercel@a': true, 'vercel@b': true })), null);
  assert.equal(toVaultSlug('vercel:flags-sdk', ctx(slugs, {})), null);
});

test('a prefix containing "/" maps the part after the last ":"', () => {
  assert.equal(toVaultSlug('apps/web:deploy', ctx(['deploy'])), 'deploy');
  assert.equal(toVaultSlug('apps/web:deploy', ctx(['vercel@m:deploy'])), null);
});

test('a name that is not in the vault is unmapped', () => {
  assert.equal(toVaultSlug('nope', ctx(['humanizer'])), null);
  assert.equal(toVaultSlug('vercel:nope', ctx(['vercel@m:flags-sdk'])), null);
  assert.equal(toVaultSlug('other:flags-sdk', ctx(['vercel@m:flags-sdk'])), null);
});

test('the plugin and skill must match exactly, not as a suffix or prefix', () => {
  const slugs = ['myvercel@m:flags-sdk', 'vercel@m:old-flags-sdk', 'vercel@m:x:flags-sdk'];
  assert.equal(toVaultSlug('vercel:flags-sdk', ctx(slugs)), null);
});

test('malformed names are unmapped', () => {
  for (const name of ['', ':', 'a:', ':b', 5, null, undefined]) assert.equal(toVaultSlug(name, ctx(['a', 'b', ':b'])), null, String(name));
});
