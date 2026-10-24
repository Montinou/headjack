import assert from 'node:assert/strict';
import path from 'node:path';
import { localSupported, localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { MIGRATIONS, openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};

localTest('an existing vault gains chunks and full text is unchanged', async () => {
  const dir = await tempDir('sv-chunks-');
  const previous = MIGRATIONS.length - 1;
  const raw = new DatabaseSync(path.join(dir, 'vault.db'));
  for (const statement of MIGRATIONS.slice(0, previous)) raw.exec(statement);
  raw.exec(`PRAGMA user_version = ${previous}`);
  raw.exec("insert into skills (slug, name, description, kind) values ('old-skill', 'Old Skill', 'Keeps full text', 'skill')");
  raw.exec("insert into versions (skill_id, sha256, status, reviewed_at) values (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'approved', '2020-01-01T00:00:00Z')");
  raw.exec('update skills set current_version_id = 1 where id = 1');
  raw.exec("insert into skill_docs (rowid, name, description, tags, body) values (1, 'Old Skill', 'Keeps full text', '', 'kilnstone body')");
  raw.close();

  const db = openVault({ dir, DatabaseSync });
  try {
    const before = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(before > previous, true);
    const hits = await createSqliteRepo(db).searchText('kilnstone', 5);
    assert.deepEqual(hits, [1]);
    assert.equal(db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n, 0);
    db.exec(`insert into chunks (skill_id, version_id, text, kind) values (1, 1, 'a', 'content')`);
    db.exec('delete from chunks');
    db.exec(`insert into chunks (skill_id, version_id, text, kind) values (1, 1, 'b', 'content')`);
    const id = db.prepare('select id from chunks').get().id;
    assert.equal(id > 1, true);
  } finally {
    db.close();
  }
});
