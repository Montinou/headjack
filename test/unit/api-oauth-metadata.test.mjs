import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiOAuthMetadata } from '../../lib/api-oauth-metadata.mjs';

const validEnv = {
  HEADJACK_API_RESOURCE_URL: 'https://vault.example/api',
  HEADJACK_AUTH_SERVER_URL: 'https://auth.example',
  HEADJACK_CLI_CLIENT_ID: 'cli-client',
};
const req = (method = 'GET') => new Request('https://vault.example/.well-known/oauth-protected-resource/api', { method });
const http = (env, isEnabled = async () => true) => apiOAuthMetadata({ isEnabled, env });

test('discovery is 404 when the flag is off', async () => {
  const off = http(validEnv, async () => false);
  for (const handler of [off.metadata, off.options]) {
    const response = await handler(req());
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
  }
  const throwing = http(validEnv, async () => { throw new Error('flag provider down'); });
  assert.equal((await throwing.metadata(req())).status, 404);
  assert.equal((await throwing.options(req('OPTIONS'))).status, 404);
});

test('discovery is 503 when configuration is missing', async () => {
  for (const env of [{}, { HEADJACK_CLI_CLIENT_ID: 'cli-client' }, { ...validEnv, HEADJACK_API_RESOURCE_URL: 'http://vault.example/api' }]) {
    const response = await http(env).metadata(req());
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /vault\.example|auth\.example|HEADJACK|cli-client/);
  }
});

test('discovery is 503 without a cli client id', async () => {
  const { HEADJACK_CLI_CLIENT_ID, ...env } = validEnv;
  const response = await http(env).metadata(req());
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /vault\.example|auth\.example|HEADJACK/);
});

test('discovery returns RFC 9728 metadata', async () => {
  const response = await http(validEnv).metadata(req());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    resource: 'https://vault.example/api',
    authorization_servers: ['https://auth.example'],
    scopes_supported: ['skills:read', 'skills:write'],
    bearer_methods_supported: ['header'],
    headjack_cli_client_id: 'cli-client',
  });
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.match(response.headers.get('content-type'), /^application\/json/);
});

test('options allows GET and OPTIONS', async () => {
  const response = await http(validEnv).options(req('OPTIONS'));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});
