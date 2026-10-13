import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApiOAuthConfig, trustedUrl } from '../../lib/oauth-config.mjs';

const issuer = 'https://auth.vault.test';
const resource = 'https://x/api';

test('loadApiOAuthConfig is null when the API resource or the issuer is unset', () => {
  assert.equal(loadApiOAuthConfig({}), null);
  assert.equal(loadApiOAuthConfig({ HEADJACK_AUTH_SERVER_URL: issuer }), null);
  assert.equal(loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: resource }), null);
  assert.equal(loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: '', HEADJACK_AUTH_SERVER_URL: issuer }), null);
  assert.equal(loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: resource, HEADJACK_AUTH_SERVER_URL: '' }), null);
});

test('loadApiOAuthConfig returns the canonical API resource, the issuer and the CLI client id', () => {
  assert.deepEqual(loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: resource, HEADJACK_AUTH_SERVER_URL: issuer }),
    { resource, issuer, cliClientId: null });
  assert.deepEqual(loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: resource, HEADJACK_AUTH_SERVER_URL: issuer, HEADJACK_CLI_CLIENT_ID: 'client_cli' }),
    { resource, issuer, cliClientId: 'client_cli' });
  assert.equal(loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: 'http://127.0.0.1:3000/api', HEADJACK_AUTH_SERVER_URL: issuer }).resource,
    'http://127.0.0.1:3000/api');
});

test('loadApiOAuthConfig rejects an unsafe or noncanonical API resource', () => {
  for (const value of ['http://evil.example/api', 'https://x/mcp', 'https://x/', 'https://x/api/', 'https://x/api?q=1', 'https://x/api#f', 'https://u:p' + '@x/api', 'https://X/api']) {
    assert.throws(() => loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: value, HEADJACK_AUTH_SERVER_URL: issuer }), { message: /^HEADJACK_API_RESOURCE_URL must/ });
  }
});

test('loadApiOAuthConfig rejects an issuer that is not an explicit origin', () => {
  for (const value of ['http://auth.vault.test', 'https://auth.vault.test/path', 'https://auth.vault.test?q=x']) {
    assert.throws(() => loadApiOAuthConfig({ HEADJACK_API_RESOURCE_URL: resource, HEADJACK_AUTH_SERVER_URL: value }), { message: /^HEADJACK_AUTH_SERVER_URL must/ });
  }
});

test('trustedUrl checks the resource path against the given suffix', () => {
  assert.equal(trustedUrl('https://x/mcp', 'NAME', { resource: true, suffix: '/mcp' }), 'https://x/mcp');
  assert.equal(trustedUrl('https://x/api', 'NAME', { resource: true, suffix: '/api' }), 'https://x/api');
  assert.throws(() => trustedUrl('https://x/api', 'NAME', { resource: true, suffix: '/mcp' }), /^Error: NAME must/);
  assert.throws(() => trustedUrl('https://x/mcp', 'NAME', { resource: true, suffix: '/api' }), /^Error: NAME must/);
  assert.throws(() => trustedUrl('https://x/undefined', 'NAME', { resource: true }), /^Error: NAME must/);
  assert.equal(trustedUrl('http://localhost:3000', 'NAME', { origin: true }), 'http://localhost:3000');
});
