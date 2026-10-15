import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setAppPassword } from '../../scripts/set-app-password.mjs';
import { closePg, migrateThrough, newPg, rowsOf } from '../pglite.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/set-app-password.mjs', import.meta.url));
const PASSWORD = "it's-" + 'x'.repeat(40); // a quote, so the literal must be escaped
const ROLE = "select rolcanlogin from pg_roles where rolname = 'headjack_app'";

const run = (env) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
    resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

test('set-app-password refuses a password under 32 characters before touching any database', async () => {
  const { code, stderr } = await run({ HEADJACK_APP_DB_PASSWORD: 'x' + 'x'.repeat(30), DATABASE_URL_OWNER: 'postgres://u:p' + '@127.0.0.1:1/db' });
  assert.equal(code, 2);
  assert.match(stderr, /HEADJACK_APP_DB_PASSWORD must be at least 32 characters/);
  assert.equal((await run({})).code, 2);
});

test('set-app-password needs DATABASE_URL_OWNER', async () => {
  const { code, stderr } = await run({ HEADJACK_APP_DB_PASSWORD: 'x' + 'x'.repeat(31) });
  assert.equal(code, 2);
  assert.match(stderr, /set DATABASE_URL_OWNER/);
});

test('setAppPassword lets the role created by 0001 log in with the password', async () => {
  const pg = await newPg();
  try {
    await migrateThrough(pg, '0009_');
    const q = rowsOf(pg);
    await setAppPassword(q, PASSWORD);
    assert.deepEqual(await q(ROLE), [{ rolcanlogin: true }]);
    const [{ rolpassword }] = await q("select rolpassword from pg_authid where rolname = 'headjack_app'");
    assert.match(rolpassword, /^(SCRAM-SHA-256\$|md5)/);
  } finally {
    await closePg(pg);
  }
});

test('setAppPassword refuses a missing role', async () => {
  const pg = await newPg();
  try {
    await assert.rejects(setAppPassword(rowsOf(pg), PASSWORD), /^Error: role headjack_app does not exist/);
  } finally {
    await closePg(pg);
  }
});

// 0001 creates the role only when absent, so a pre-existing one keeps whatever it had: refuse anything but the
// NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT role with no memberships, and leave it NOLOGIN.
test('setAppPassword refuses a role with superuser, BYPASSRLS, CREATEROLE, CREATEDB or INHERIT', async () => {
  for (const attr of ['superuser', 'bypassrls', 'createrole', 'createdb', 'inherit']) {
    const pg = await newPg();
    try {
      const q = rowsOf(pg);
      await pg.exec(`create role headjack_app nologin ${attr === 'inherit' ? '' : 'noinherit'} ${attr}`);
      await assert.rejects(setAppPassword(q, PASSWORD), new RegExp(`headjack_app must not have ${attr}`, 'i'), attr);
      assert.deepEqual(await q(ROLE), [{ rolcanlogin: false }], attr);
    } finally {
      await closePg(pg);
    }
  }
});

test('setAppPassword refuses a role that is a member of another role', async () => {
  const pg = await newPg();
  try {
    await migrateThrough(pg, '0009_');
    const q = rowsOf(pg);
    await pg.exec('create role other_role nologin; grant other_role to headjack_app');
    await assert.rejects(setAppPassword(q, PASSWORD), /headjack_app must not be a member of any role \(other_role\)/);
    assert.deepEqual(await q(ROLE), [{ rolcanlogin: false }]);
  } finally {
    await closePg(pg);
  }
});
