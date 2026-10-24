import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { localSupported, localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault, openVaultReadOnly } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { loadVec } from '../../lib/local/vec.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};

const DIM = 1536;

// Unit vectors on two axes: cosine distance is 0 for the query axis and 1 for the other.
function axis(index) {
  const values = Array(DIM).fill(0);
  values[index] = 1;
  return JSON.stringify(values);
}

function publishSkill(db) {
  db.exec("insert into skills (slug, name, description, kind) values ('published-skill', 'Published Skill', 'Keeps full text', 'skill')");
  db.exec("insert into versions (skill_id, sha256, status, reviewed_at) values (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'approved', '2020-01-01T00:00:00Z')");
  db.exec('update skills set current_version_id = 1 where id = 1');
  db.exec("insert into skill_docs (rowid, name, description, tags, body) values (1, 'Published Skill', 'Keeps full text', '', 'kilnstone body')");
}

function chunkVecs(db) {
  return db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n;
}

function recordingDatabaseSync(calls) {
  function Spy(file, options) {
    calls.push(options);
    if (arguments.length < 2) return new DatabaseSync(file);
    return new DatabaseSync(file, options);
  }
  return Spy;
}

localTest('a missing vec path returns false and searchSignals still returns the published skill', async () => {
  const dir = await tempDir('sv-vec-miss-');
  const db = openVault({ dir, DatabaseSync });
  try {
    publishSkill(db);
    assert.equal(loadVec(db, path.join(dir, 'no-such-vec0.so')), false);
    assert.equal(chunkVecs(db), 0);
    const hits = await createSqliteRepo(db).searchSignals('kilnstone', {});
    assert.equal(hits.length, 1);
    assert.equal(hits[0].slug, 'published-skill');
  } finally {
    db.close();
  }
});

localTest('openVault constructs DatabaseSync without allowExtension unless the caller sets it', async () => {
  const dir = await tempDir('sv-vec-open-');
  const calls = [];
  const db = openVault({ dir, DatabaseSync: recordingDatabaseSync(calls) });
  try {
    assert.deepEqual(calls, [undefined]);
  } finally {
    db.close();
  }

  calls.length = 0;
  const allowed = openVault({ dir, DatabaseSync: recordingDatabaseSync(calls), allowExtension: true });
  try {
    assert.deepEqual(calls, [{ allowExtension: true }]);
  } finally {
    allowed.close();
  }
});

localTest('openVaultReadOnly omits allowExtension unless the caller sets it', async () => {
  const dir = await tempDir('sv-vec-ro-');
  openVault({ dir, DatabaseSync }).close();
  const calls = [];
  const Spy = recordingDatabaseSync(calls);
  const opened = openVaultReadOnly({ dir, DatabaseSync: Spy, busyTimeoutMs: 50 });
  try {
    assert.equal(opened.ok, true);
    assert.equal(Object.hasOwn(calls[0], 'allowExtension'), false);
    assert.equal(calls[0].readOnly, true);
    assert.equal(calls[0].timeout, 50);
  } finally {
    opened.db.close();
  }

  calls.length = 0;
  const allowed = openVaultReadOnly({ dir, DatabaseSync: Spy, busyTimeoutMs: 50, allowExtension: true });
  try {
    assert.equal(allowed.ok, true);
    assert.equal(calls[0].allowExtension, true);
    assert.equal(calls[0].readOnly, true);
    assert.equal(calls[0].timeout, 50);
  } finally {
    allowed.db.close();
  }
});

localTest('loadVec rethrows when the connection was opened without allowExtension', async () => {
  const dir = await tempDir('sv-vec-deny-');
  const present = path.join(dir, 'not-vec.so');
  await writeFile(present, 'not a shared library');
  const db = openVault({ dir, DatabaseSync });
  try {
    assert.throws(() => loadVec(db, present), /extension loading is not allowed/);
    assert.equal(chunkVecs(db), 0);
  } finally {
    db.close();
  }
});

localTest('a real path that fails to load returns false and does not log the path', async () => {
  const dir = await tempDir('sv-vec-bad-');
  const junk = path.join(dir, 'vec0.dylib');
  await writeFile(junk, 'not a shared library');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  const logged = [];
  const originals = { error: console.error, log: console.log, warn: console.warn };
  for (const key of Object.keys(originals)) console[key] = (...args) => logged.push(args.map(String).join(' '));
  try {
    assert.equal(loadVec(db, junk), false);
    assert.equal(chunkVecs(db), 0);
    assert.deepEqual(logged, []);
  } finally {
    Object.assign(console, originals);
    db.close();
  }
});

localTest('vendored sqlite-vec ranks the cosine-nearer 1536-float row first', async () => {
  const previous = process.env.HEADJACK_VEC_PATH;
  delete process.env.HEADJACK_VEC_PATH;
  const dir = await tempDir('sv-vec-near-');
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    assert.equal(loadVec(db), true);
    const insert = db.prepare('insert into chunk_vecs(rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)');
    insert.run(1n, axis(0), 10n, 20n);
    insert.run(2n, axis(1), 10n, 21n);
    const rows = db.prepare('select rowid, distance from chunk_vecs where embedding match ? and k = 2').all(axis(0));
    assert.equal(rows.length, 2);
    const ranked = rows.map((row) => ({ id: Number(row.rowid), similarity: 1 - row.distance }));
    assert.equal(ranked[0].id, 1);
    assert.ok(ranked[0].similarity > ranked[1].similarity);
    assert.ok(ranked[0].similarity > 0.99);
    assert.ok(Math.abs(ranked[1].similarity) < 0.01);
  } finally {
    if (previous === undefined) delete process.env.HEADJACK_VEC_PATH;
    else process.env.HEADJACK_VEC_PATH = previous;
    db.close();
  }
});
