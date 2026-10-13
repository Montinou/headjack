import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { localSupported, localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { MIGRATIONS, isBusy, openVault, vaultInfo } from '../../lib/local/schema.mjs';

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
