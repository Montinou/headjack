import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dumpSchema } from '../../db/catalog.mjs';
import { closePg, newPg, migrateThrough, rowsOf, V1_MIGRATIONS } from '../pglite.mjs';

// The spec §4 gate: drizzle/0000_baseline builds exactly the schema db/migrations/001-003 built in production.
test('drizzle/0000_baseline builds the same public schema as the v1 SQL migrations', async () => {
  const v1 = await newPg();
  for (const f of (await readdir(V1_MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort()) {
    await v1.exec(`begin; ${await readFile(path.join(V1_MIGRATIONS, f), 'utf8')}; commit;`);
  }
  const baseline = await newPg();
  await migrateThrough(baseline, '0000_');
  const a = await dumpSchema(rowsOf(v1));
  const b = await dumpSchema(rowsOf(baseline));
  await closePg(v1, baseline);
  assert.deepEqual(b.filter((l) => !a.includes(l)), [], 'only in the drizzle baseline');
  assert.deepEqual(a.filter((l) => !b.includes(l)), [], 'only in the v1 migrations');
  // Guard against a vacuous pass: the dump really covers the parity-critical pieces.
  for (const needle of [
    /^column chunks\.embedding #5 vector\(1536\) not null$/,
    /^index chunks\.chunks_embedding_idx .*USING hnsw \(embedding vector_cosine_ops\)$/,
    /^column skills\.fts #13 tsvector generated .*setweight\(to_tsvector\('english'::regconfig, name\), 'A'::"char"\)/,
    /^constraint sources\.sources_kind_url_key UNIQUE NULLS NOT DISTINCT \(kind, url\)$/,
    /^constraint chunks\.chunks_kind_check CHECK/,
    /^constraint skills\.skills_slug_key UNIQUE \(slug\)$/,
  ]) {
    assert.ok(a.some((l) => needle.test(l)), `dump has ${needle}`);
  }
});

// The dump must see what the column/constraint/index lines alone would miss: a column moved to another position
// (same type, nullability and default) and a trigger (with its function).
test('dumpSchema tells apart a swapped column order and an added trigger', async () => {
  const base = await newPg();
  await migrateThrough(base, '0000_');
  const want = await dumpSchema(rowsOf(base));

  const swapped = await newPg();
  await migrateThrough(swapped, '0000_');
  await swapped.exec('alter table upstream drop column checked_at; alter table upstream add column checked_at timestamptz;');
  const moved = await dumpSchema(rowsOf(swapped));
  assert.notDeepEqual(moved, want, 'a moved column changes the dump');
  assert.ok(moved.some((l) => /^column upstream\.checked_at\b/.test(l) && !want.includes(l)), 'the moved column line differs');

  const triggered = await newPg();
  await migrateThrough(triggered, '0000_');
  await triggered.exec(`create function touch() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger skills_touch before update on skills for each row execute function touch();`);
  const extra = (await dumpSchema(rowsOf(triggered))).filter((l) => !want.includes(l));
  assert.ok(extra.some((l) => /^trigger skills\.skills_touch /.test(l)), `the trigger shows up, got ${JSON.stringify(extra)}`);
  assert.ok(extra.some((l) => /^function touch\(\)/.test(l)), `the function shows up, got ${JSON.stringify(extra)}`);
  assert.ok(!want.some((l) => /^function /.test(l)), 'functions owned by an extension (pgvector) stay out of the dump');
  await closePg(base, swapped, triggered);
});

test('migrateThrough removes its temporary migrations folder and closePg closes instances', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'sv-tmp-'));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = scratch; // os.tmpdir() reads TMPDIR on every call
  try {
    const pg = await newPg();
    await migrateThrough(pg, '0000_');
    assert.deepEqual(await readdir(scratch), [], 'no sv-mig-* folder left behind');
    const other = await newPg();
    await closePg(pg, other);
    assert.ok(pg.closed && other.closed, 'both instances closed');
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    await rm(scratch, { recursive: true, force: true });
  }
});
