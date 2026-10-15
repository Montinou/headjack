// Test helpers over db/pglite.mjs: unit vectors and a v1-shaped database. Task 7 adds appPool().
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { V1_MIGRATIONS, newPg } from '../db/pglite.mjs';

export { MIGRATIONS, V1_MIGRATIONS, newPg, rowsOf, migrateThrough, migratedPg, closePg } from '../db/pglite.mjs';

// pg-Pool-shaped wrapper over one PGlite. Every client runs as `role` (default headjack_app: not the table owner,
// not superuser, so FORCE RLS and the grants apply). PGlite has one connection, so clients are handed out one at a time.
export function appPool(pg, role = 'headjack_app') {
  let queue = Promise.resolve();
  const connect = async () => {
    let done;
    const turn = new Promise((resolve) => { done = resolve; });
    const previous = queue;
    queue = previous.then(() => turn);
    await previous;
    await pg.exec(`set role ${role}`);
    return {
      query: (text, params) => pg.query(text, params),
      release: () => { pg.exec('reset role').finally(done); },
    };
  };
  return {
    connect,
    async query(text, params) {
      const client = await connect();
      try { return await client.query(text, params); } finally { client.release(); }
    },
  };
}

export const vec = (i) => Array.from({ length: 1536 }, (_, j) => (j === i ? 1 : 0));
export const vecText = (i) => `[${vec(i).join(',')}]`;

const GRANDFATHERED = 'grandfathered: instalada antes del vault, no revisada';

// A database built by the v1 runner's SQL (db/migrations/001-003), holding the shapes production has: two versions
// with identical tarball bytes, a rejected version and a plugin without tarball, a github and a local source.
export async function v1Database() {
  const pg = await newPg();
  for (const f of (await readdir(V1_MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort()) {
    await pg.exec(`begin; ${await readFile(path.join(V1_MIGRATIONS, f), 'utf8')}; commit;`);
  }
  await pg.exec(`
    insert into sources (kind, url) values ('github', 'https://github.com/x/y'), ('local', null);
    insert into skills (slug, name, description, kind, source_id, tags, tags_text)
      values ('alpha', 'alpha', 'alpha renders video', 'skill', 1, '{video}', 'video'),
             ('beta', 'beta', 'beta writes docs', 'skill', 2, '{}', ''),
             ('plug@mkt', 'plug', 'a plugin', 'plugin', null, '{}', '');
    insert into versions (skill_id, commit_sha, sha256, tarball, size, status, review_notes)
      values (1, '${'a'.repeat(40)}', '${'1'.repeat(64)}', '\\x1f8b0001'::bytea, 4, 'approved', 'ok'),
             (2, null, '${'2'.repeat(64)}', '\\x1f8b0001'::bytea, 4, 'approved', '${GRANDFATHERED}'),
             (2, null, '${'3'.repeat(64)}', null, null, 'rejected', 'no'),
             (3, null, '${'4'.repeat(64)}', null, null, 'approved', 'ok');
    update skills set current_version_id = 1 where id = 1;
    update skills set current_version_id = 2 where id = 2;
    update skills set current_version_id = 4 where id = 3;
    insert into chunks (skill_id, version_id, text, embedding, kind)
      values (1, 1, 'alpha render', '${vecText(0)}', 'content'), (2, 2, 'beta docs', '${vecText(1)}', 'query');
    insert into upstream (skill_id, latest_commit, update_available) values (1, '${'a'.repeat(40)}', false), (2, null, false);
  `);
  return pg;
}
