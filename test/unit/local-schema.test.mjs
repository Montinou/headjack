import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { localSupported, localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { UserError } from '../../lib/errors.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { MIGRATIONS, isBusy, openVault, openVaultReadOnly, vaultInfo } from '../../lib/local/schema.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};
const mode = async (p) => (await stat(p)).mode & 0o777;

localTest('openVault creates vault.db mode 600 in a mode 700 directory, tightening an existing 755 directory', async () => {
  const fresh = path.join(await tempDir('sv-vault-'), 'a', 'b');
  openVault({ dir: fresh, DatabaseSync }).close();
  assert.equal(await mode(fresh), 0o700);
  assert.equal(await mode(path.join(fresh, 'vault.db')), 0o600);

  const existing = path.join(await tempDir('sv-vault-'), 'state');
  await mkdir(existing);
  await chmod(existing, 0o755);
  openVault({ dir: existing, DatabaseSync }).close();
  assert.equal(await mode(existing), 0o700);
  assert.equal(await mode(path.join(existing, 'vault.db')), 0o600);
});

localTest('openVault sets WAL, busy_timeout and foreign_keys, and reopening is idempotent', async () => {
  const dir = await tempDir('sv-vault-');
  const db = openVault({ dir, DatabaseSync });
  assert.equal({ ...db.prepare('PRAGMA journal_mode').get() }.journal_mode, 'wal');
  assert.equal(Object.values({ ...db.prepare('PRAGMA busy_timeout').get() })[0], 5000);
  assert.equal({ ...db.prepare('PRAGMA foreign_keys').get() }.foreign_keys, 1);
  assert.deepEqual(vaultInfo(db), { schemaVersion: MIGRATIONS.length, skills: 0 });
  db.close();
  const again = openVault({ dir, DatabaseSync });
  assert.deepEqual(vaultInfo(again), { schemaVersion: MIGRATIONS.length, skills: 0 });
  assert.equal({ ...again.prepare('PRAGMA user_version').get() }.user_version, MIGRATIONS.length);
  again.close();
});

localTest('openVault refuses a vault written by a newer headjack', async () => {
  const dir = await tempDir('sv-vault-');
  const raw = new DatabaseSync(path.join(dir, 'vault.db'));
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  raw.close();
  assert.throws(() => openVault({ dir, DatabaseSync }), /newer headjack/);
});

localTest('openVault reports a file SQLite cannot read as an invalid vault and leaves its bytes untouched', async () => {
  const dir = await tempDir('sv-vault-');
  const file = path.join(dir, 'vault.db');
  const junk = Buffer.from('these are my notes, not a database\n'.repeat(40));
  await writeFile(file, junk);
  assert.throws(() => openVault({ dir, DatabaseSync }), (e) => /is not a valid vault/.test(e.message) && e.message.startsWith(file));
  assert.deepEqual(await readFile(file), junk);
});

localTest('a file SQLite cannot read carries the vault_damaged code, a newer vault does not', async () => {
  const dir = await tempDir('sv-vault-');
  await writeFile(path.join(dir, 'vault.db'), Buffer.from('these are my notes, not a database\n'.repeat(40)));
  assert.throws(() => openVault({ dir, DatabaseSync }), (e) => e instanceof UserError && e.code === 'vault_damaged');
  const newer = await tempDir('sv-vault-');
  const raw = new DatabaseSync(path.join(newer, 'vault.db'));
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  raw.close();
  assert.throws(() => openVault({ dir: newer, DatabaseSync }), (e) => e instanceof UserError && e.code === undefined);
});

localTest('isBusy is true for the lock error of a second writer and false for an ordinary Error', async () => {
  const dir = await tempDir('sv-vault-');
  const first = openVault({ dir, DatabaseSync });
  const second = new DatabaseSync(path.join(dir, 'vault.db'));
  second.exec('PRAGMA busy_timeout = 50');
  first.exec('BEGIN IMMEDIATE');
  let err;
  try {
    second.exec("insert into sources (kind, url) values ('local', null)");
  } catch (e) {
    err = e;
  } finally {
    first.exec('ROLLBACK');
    second.close();
    first.close();
  }
  assert.ok(err, 'the second writer must fail while the first holds BEGIN IMMEDIATE');
  assert.equal(isBusy(err), true);
  assert.equal(isBusy(new Error('database is locked')), false);
  assert.equal(isBusy(undefined), false);
});

localTest('openVaultReadOnly reports a missing vault and creates neither the directory nor the file', async () => {
  const parent = await tempDir('sv-vault-');
  const dir = path.join(parent, 'absent');
  assert.deepEqual(openVaultReadOnly({ dir, DatabaseSync }), { ok: false, reason: 'no-vault' });
  assert.equal(existsSync(dir), false);
  const empty = await tempDir('sv-vault-');
  assert.deepEqual(openVaultReadOnly({ dir: empty, DatabaseSync }), { ok: false, reason: 'no-vault' });
  assert.equal(existsSync(path.join(empty, 'vault.db')), false);
});

localTest('openVaultReadOnly reports a vault older or newer than this headjack as schema and applies no migration', async () => {
  const older = await tempDir('sv-vault-');
  const raw = new DatabaseSync(path.join(older, 'vault.db'));
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  raw.close();
  assert.deepEqual(openVaultReadOnly({ dir: older, DatabaseSync }), { ok: false, reason: 'schema' });
  const check = new DatabaseSync(path.join(older, 'vault.db'), { readOnly: true });
  assert.equal({ ...check.prepare('PRAGMA user_version').get() }.user_version, MIGRATIONS.length - 1);
  check.close();

  const newer = await tempDir('sv-vault-');
  const rawNewer = new DatabaseSync(path.join(newer, 'vault.db'));
  rawNewer.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  rawNewer.close();
  assert.deepEqual(openVaultReadOnly({ dir: newer, DatabaseSync }), { ok: false, reason: 'schema' });
});

localTest('openVaultReadOnly opens a current vault for reads and refuses writes', async () => {
  const dir = await tempDir('sv-vault-');
  openVault({ dir, DatabaseSync }).close();
  const opened = openVaultReadOnly({ dir, DatabaseSync });
  assert.equal(opened.ok, true);
  try {
    assert.equal({ ...opened.db.prepare('select count(*) as n from skills').get() }.n, 0);
    assert.throws(() => opened.db.exec("insert into sources (kind, url) values ('local', null)"), /readonly/i);
  } finally {
    opened.db.close();
  }
});

localTest('openVaultReadOnly returns busy within 400 ms while another connection holds an exclusive lock', async () => {
  const dir = await tempDir('sv-vault-');
  openVault({ dir, DatabaseSync }).close();
  const holder = new DatabaseSync(path.join(dir, 'vault.db'));
  holder.exec('PRAGMA locking_mode = EXCLUSIVE');
  holder.exec('BEGIN IMMEDIATE');
  holder.exec("insert into sources (kind, url) values ('local', null)");
  const started = performance.now();
  let result;
  try {
    result = openVaultReadOnly({ dir, DatabaseSync });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.ok(elapsed < 400, `took ${elapsed} ms`);
});
