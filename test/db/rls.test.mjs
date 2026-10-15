// Closed RLS (spec §4), checked with raw SQL as the real non-owner role: no code filter is involved anywhere.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDb } from '../../lib/db.mjs';
import { appPool, migratedPg, vecText } from '../pglite.mjs';

let pg, db, A, B;

// One skill with a current version, a tarball blob, a chunk and an upstream row, written as `ownerId`.
async function seedSkill(ownerId, slug, bytes, description) {
  return db.withOwner(ownerId, async (tx) => {
    const one = async (text, params) => (await tx.query(text, params)).rows[0];
    const src = await one("insert into sources (kind, url) values ('github', 'https://github.com/x/y') on conflict (owner_id, kind, url) do update set default_ref = excluded.default_ref returning id");
    const skill = await one("insert into skills (slug, name, description, kind, source_id) values ($1, $1, $2, 'skill', $3) returning id", [slug, description, src.id]);
    const blob = await one('select app.put_blob($1) as sha256', [Buffer.from(bytes)]);
    const version = await one("insert into versions (skill_id, sha256, blob_sha256, size, status) values ($1, $2, $3, $4, 'approved') returning id", [skill.id, '1'.repeat(64), blob.sha256, bytes.length]);
    await tx.query('update skills set current_version_id = $2 where id = $1', [skill.id, version.id]);
    await tx.query('insert into chunks (skill_id, version_id, text, embedding) values ($1, $2, $3, $4::vector)', [skill.id, version.id, description, vecText(0)]);
    await tx.query('insert into upstream (skill_id) values ($1)', [skill.id]);
    return Number(skill.id);
  });
}

const count = (ownerId, table) => db.withOwner(ownerId, (tx) => tx.query(`select count(*)::int as n from ${table}`)).then((r) => r.rows[0].n);

before(async () => {
  pg = await migratedPg();
  db = createDb(appPool(pg));
  A = await db.resolveOwner('user', 'user-a');
  B = await db.resolveOwner('user', 'user-b');
  await seedSkill(A, 'same-slug', 'shared-bytes', 'owner a copy');
  await seedSkill(B, 'same-slug', 'shared-bytes', 'owner b copy');
  await seedSkill(B, 'b-only', 'b-private-bytes', 'zebra pipeline');
});

test('the app role really is a non-owner, non-superuser role without BYPASSRLS, and FORCE is on', async () => {
  const client = await appPool(pg).connect();
  try {
    const { rows: [r] } = await client.query(
      `select current_user as who, rolsuper, rolbypassrls,
              (select relowner::regrole::text from pg_class where relname = 'skills') as owner
         from pg_roles where rolname = current_user`,
    );
    assert.deepEqual(r, { who: 'headjack_app', rolsuper: false, rolbypassrls: false, owner: 'postgres' });
    const { rows } = await client.query(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
          and relrowsecurity and relforcerowsecurity order by relname`,
    );
    assert.deepEqual(rows.map((x) => x.relname), ['blobs', 'chunks', 'install_events', 'owners', 'search_events', 'skills', 'sources', 'upstream', 'versions']);
  } finally { client.release(); }
});

test('every public table with an owner_id column has RLS enabled and forced', async () => {
  const { rows } = await pg.query(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join information_schema.columns col on col.table_name = c.relname and col.table_schema = 'public'
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and col.column_name = 'owner_id'
      order by c.relname`,
  );
  assert.ok(rows.some((r) => r.relname === 'search_events') && rows.some((r) => r.relname === 'install_events'));
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity], [true, true], r.relname);
});

test('search_events and install_events: what owner A inserts, owner B cannot see', async () => {
  await db.withOwner(A, async (tx) => {
    await tx.query("insert into search_events (session_id, variant, query_hmac, top_slugs) values ('s-a', 'rrf-english', 'h', '{same-slug}')");
    await tx.query("insert into install_events (session_id, slug, kind, source) values ('s-a', 'same-slug', 'skill', 'suggest')");
  });
  for (const t of ['search_events', 'install_events']) {
    assert.equal(await count(A, t), 1, `A ${t}`);
    assert.equal(await count(B, t), 0, `B ${t}`);
  }
});

test('with no owner set, every owner-scoped table and blobs return 0 rows', async () => {
  const client = await appPool(pg).connect();
  try {
    for (const t of ['owners', 'skills', 'versions', 'sources', 'chunks', 'upstream', 'blobs']) {
      assert.equal((await client.query(`select count(*)::int as n from ${t}`)).rows[0].n, 0, t);
    }
  } finally { client.release(); }
});

test('a pooled connection that ran an earlier withOwner sees 0 rows, not an error, once the setting is back to ""', async () => {
  await count(A, 'skills');
  const client = await appPool(pg).connect();
  try {
    assert.equal((await client.query("select current_setting('app.owner_id', true) as v")).rows[0].v, '', 'Postgres keeps an emptied custom setting');
    assert.equal((await client.query('select count(*)::int as n from skills')).rows[0].n, 0);
  } finally { client.release(); }
});

test('identical slugs coexist, one per owner; each owner counts only its own rows in every table', async () => {
  for (const t of ['skills', 'versions', 'sources', 'chunks', 'upstream']) {
    assert.equal(await count(A, t), 1, `A ${t}`);
    assert.equal(await count(B, t), t === 'sources' ? 1 : 2, `B ${t}`);
  }
  const { rows } = await db.withOwner(A, (tx) => tx.query("select description from skills where slug = 'same-slug'"));
  assert.deepEqual(rows, [{ description: 'owner a copy' }]);
});

test("owner A cannot update, delete or re-own owner B's rows, even addressing them by id", async () => {
  const { rows: [bSkill] } = await db.withOwner(B, (tx) => tx.query("select id from skills where slug = 'b-only'"));
  const touched = await db.withOwner(A, async (tx) => ({
    skills: (await tx.query('update skills set name = $2 where id = $1 returning id', [bSkill.id, 'hacked'])).rows.length,
    upstream: (await tx.query('update upstream set update_available = true where skill_id = $1 returning skill_id', [bSkill.id])).rows.length,
    chunks: (await tx.query('delete from chunks where skill_id = $1 returning id', [bSkill.id])).rows.length,
  }));
  assert.deepEqual(touched, { skills: 0, upstream: 0, chunks: 0 });
  await assert.rejects(db.withOwner(A, (tx) => tx.query("insert into skills (slug, name, description, kind, owner_id) values ('x', 'x', 'x', 'skill', $1)", [B])), /row-level security/);
  await assert.rejects(db.withOwner(A, (tx) => tx.query("update skills set owner_id = $1 where slug = 'same-slug'", [B])), /row-level security/);
  const { rows: [still] } = await db.withOwner(B, (tx) => tx.query("select name from skills where slug = 'b-only'"));
  assert.equal(still.name, 'b-only');
});

test("owner A cannot attach a version or chunk to owner B's skill: the composite foreign keys reject it", async () => {
  const { rows: [bSkill] } = await db.withOwner(B, (tx) => tx.query("select id, current_version_id from skills where slug = 'b-only'"));
  await assert.rejects(
    db.withOwner(A, (tx) => tx.query("insert into versions (skill_id, sha256, status) values ($1, $2, 'rejected')", [bSkill.id, '9'.repeat(64)])),
    /versions_skill_owner_fkey/,
  );
  await assert.rejects(
    db.withOwner(A, (tx) => tx.query('insert into chunks (skill_id, version_id, text, embedding) values ($1, $2, $3, $4::vector)', [bSkill.id, bSkill.current_version_id, 'x', vecText(1)])),
    /chunks_skill_owner_fkey/,
  );
});

test('blobs: one shared row per content, readable only through an own version, writable only via app.put_blob', async () => {
  assert.equal((await pg.query('select count(*)::int as n from blobs')).rows[0].n, 2, 'shared-bytes stored once');
  assert.equal(await count(A, 'blobs'), 1);
  assert.equal(await count(B, 'blobs'), 2);
  const { rows } = await db.withOwner(A, (tx) => tx.query("select encode(data, 'escape') as data from blobs"));
  assert.deepEqual(rows, [{ data: 'shared-bytes' }]);
  await assert.rejects(db.withOwner(A, (tx) => tx.query("insert into blobs (sha256, data, size) values ($1, '\\x01'::bytea, 1)", ['0'.repeat(64)])), /permission denied/);
  await assert.rejects(db.withOwner(A, (tx) => tx.query('delete from blobs')), /permission denied/);
  await assert.rejects(pg.query("insert into blobs (sha256, data, size) values ($1, '\\x01'::bytea, 1)", ['0'.repeat(64)]), /blobs_content_address_check/, 'not even the owner can mislabel bytes');
  const client = await appPool(pg).connect();
  try {
    await assert.rejects(client.query("select app.put_blob('\\x01'::bytea)"), /put_blob needs app.owner_id/);
  } finally { client.release(); }
});

test("knowing the hash is not enough: A cannot point a version at a blob only B uploaded", async () => {
  const bHash = createHash('sha256').update('b-private-bytes').digest('hex');
  const { rows: [aSkill] } = await db.withOwner(A, (tx) => tx.query("select id from skills where slug = 'same-slug'"));
  const refer = (tx, hash, v = '8') => tx.query("insert into versions (skill_id, sha256, blob_sha256, status) values ($1, $2, $3, 'rejected')", [aSkill.id, v.repeat(64), hash]);
  await assert.rejects(db.withOwner(A, (tx) => refer(tx, bHash)), /blob not uploaded by this owner/);
  assert.equal(await count(A, 'blobs'), 1, "B's bytes stay invisible to A");
  await assert.rejects(pg.query('update versions set blob_sha256 = $1 where owner_id = $2', [bHash, A]), /blob not uploaded by this owner/, 'the owner role is held to it too');
  // Allowed, then rolled back: a blob A already holds needs no new upload; one A uploads in the same transaction is fine.
  const done = new Error('rollback');
  await assert.rejects(db.withOwner(A, async (tx) => {
    await refer(tx, createHash('sha256').update('shared-bytes').digest('hex'));
    assert.equal((await tx.query('select app.put_blob($1) as h', [Buffer.from('b-private-bytes')])).rows[0].h, bHash);
    await refer(tx, bHash, '7');
    throw done;
  }), (e) => e === done);
});

test('owners: each owner sees only its own row; resolve_owner is the only way to create one', async () => {
  const { rows } = await db.withOwner(A, (tx) => tx.query('select id from owners'));
  assert.deepEqual(rows.map((r) => Number(r.id)), [A]);
  await assert.rejects(db.withOwner(A, (tx) => tx.query("insert into owners (kind, ref_id) values ('user', 'evil')")), /permission denied/);
  assert.equal(await db.resolveOwner('user', 'user-a'), A, 'stable for the same subject');
  await assert.rejects(db.resolveOwner('team', 'x'), /invalid owner reference/);
  await assert.rejects(db.resolveOwner('user', ''), /invalid owner reference/);
  const ids = await db.listOwnerIds();
  assert.ok(ids.includes(A) && ids.includes(B));
});

test('the app role has no access to invites, the auth schema or the migrations table', async () => {
  for (const sql of ['select * from invites', 'select * from auth."user"', 'select * from drizzle.__drizzle_migrations', 'select * from app.blob_holders']) {
    await assert.rejects(db.withOwner(A, (tx) => tx.query(sql)), /permission denied/, sql);
  }
});
