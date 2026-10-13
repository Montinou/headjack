import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { openApi } from '../../cli/connect.mjs';
import { tokenFile } from '../../cli/credentials.mjs';
import { UserError } from '../../lib/errors.mjs';

const HOSTED = 'https://headjack.example.invalid';
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

localTest('without HEADJACK_URL the api is the local vault, and close is idempotent', async () => {
  const dir = await tempDir('sv-connect-');
  const logged = [];
  const { api, close } = await openApi({ dir }, { env: {}, log: (m) => logged.push(m) });
  try {
    assert.deepEqual(await api.list({}), { skills: [], total: 0, limit: 50, offset: 0 });
    assert.deepEqual(logged, [], 'no saved login, so no warning');
  } finally {
    close();
  }
  assert.doesNotThrow(() => close());
  assert.doesNotThrow(() => close());
});

test('with HEADJACK_URL and a stored credential the api is hosted, and close is a no-op', async () => {
  const dir = await tempDir('sv-connect-');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers.authorization });
    return json({ skills: [], total: 0, limit: 50, offset: 0 });
  };
  const { api, close } = await openApi({ dir }, { env: { HEADJACK_URL: HOSTED, HEADJACK_TOKEN: 'ak' }, fetchImpl });
  await api.list({});
  assert.deepEqual(seen, [{ url: `${HOSTED}/api/skills?limit=50&offset=0`, authorization: 'Bearer ak' }]);
  assert.equal(typeof close, 'function');
  assert.equal(close(), undefined);
  assert.equal(close(), undefined);
});

test('hosted mode without a credential is the not-logged-in UserError', async () => {
  const dir = await tempDir('sv-connect-');
  await assert.rejects(
    openApi({ dir }, { env: { HEADJACK_URL: HOSTED } }),
    (e) => e instanceof UserError && e.message === 'not logged in: run headjack login, or set HEADJACK_TOKEN (an API key)',
  );
});

test('HEADJACK_MODE=remote without HEADJACK_URL is refused with the URL message', async () => {
  const dir = await tempDir('sv-connect-');
  await assert.rejects(
    openApi({ dir }, { env: { HEADJACK_MODE: 'remote' } }),
    (e) => e instanceof UserError && e.message.startsWith('HEADJACK_URL is not set'),
  );
});

test('an invalid HEADJACK_MODE is a UserError', async () => {
  const dir = await tempDir('sv-connect-');
  await assert.rejects(
    openApi({ dir }, { env: { HEADJACK_MODE: 'cloud' } }),
    (e) => e instanceof UserError && e.message === 'HEADJACK_MODE must be local or remote',
  );
});

localTest('HEADJACK_MODE=local wins over HEADJACK_URL and says nothing about a saved login', async () => {
  const dir = await tempDir('sv-connect-');
  await writeFile(tokenFile(dir), '{}');
  const logged = [];
  const fetchImpl = async () => { throw new Error('hosted fetch must not be used'); };
  const { api, close } = await openApi(
    { dir },
    { env: { HEADJACK_MODE: 'local', HEADJACK_URL: HOSTED, HEADJACK_TOKEN: 'ak' }, log: (m) => logged.push(m), fetchImpl },
  );
  try {
    assert.equal((await api.list({})).total, 0);
    assert.deepEqual(logged, []);
  } finally {
    close();
  }
});

localTest('an implicit local mode with a saved login warns through the injected log, once', async () => {
  const dir = await tempDir('sv-connect-');
  await writeFile(tokenFile(dir), '{}');
  const logged = [];
  const { close } = await openApi({ dir }, { env: {}, log: (m) => logged.push(m) });
  close();
  assert.deepEqual(logged, [
    'headjack: HEADJACK_URL is not set, using the local vault; set HEADJACK_URL (or HEADJACK_MODE=remote) to use your hosted vault',
  ]);
});

localTest('the default log is console.error, read when openApi runs', async (t) => {
  const dir = await tempDir('sv-connect-');
  await writeFile(tokenFile(dir), '{}');
  const lines = [];
  t.mock.method(console, 'error', (m) => lines.push(m));
  const { close } = await openApi({ dir }, { env: {} });
  close();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^headjack: HEADJACK_URL is not set/);
});

localTest('a state directory that cannot be created is one UserError naming it', async () => {
  const dir = await tempDir('sv-connect-');
  const blocker = `${dir}/file`;
  await writeFile(blocker, 'x');
  await assert.rejects(
    openApi({ dir: `${blocker}/state` }, { env: {} }),
    (e) => e instanceof UserError && e.message.startsWith(`cannot use the state directory ${blocker}/state (`),
  );
});
