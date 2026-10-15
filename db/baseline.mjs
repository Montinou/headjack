// Adopting drizzle on the live database: record drizzle/0000_baseline as applied without running it, exactly the way
// drizzle's migrator records a migration (drizzle.__drizzle_migrations: hash = sha256 of the file, created_at = the
// journal's `when`). drizzle-kit migrate then applies only the migrations after it.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { dumpSchema } from './catalog.mjs';

export async function baselineEntry(migrationsFolder) {
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
  const entry = journal.entries[0];
  if (!entry || !entry.tag.endsWith('_baseline')) throw new Error(`the first migration must be the baseline, got ${entry?.tag}`);
  const sql = await readFile(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
  return { tag: entry.tag, when: entry.when, hash: createHash('sha256').update(sql).digest('hex') };
}

// query(text, params) → rows, on a transaction the caller commits. Returns 'marked' or 'already-marked'.
export async function markBaseline(query, migrationsFolder) {
  const { tag, when, hash } = await baselineEntry(migrationsFolder);
  const [{ v1 }] = await query("select to_regclass('public.skills') is not null as v1");
  if (!v1) throw new Error('public.skills does not exist: this database has no v1 schema to adopt');
  await query('create schema if not exists "drizzle"');
  await query('create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)');
  const applied = await query('select hash, created_at from "drizzle"."__drizzle_migrations" order by created_at');
  if (applied.some((r) => r.hash === hash && Number(r.created_at) === when)) return 'already-marked';
  if (applied.length) throw new Error(`drizzle.__drizzle_migrations already has ${applied.length} row(s) but not ${tag}; refusing to guess`);
  await query('insert into "drizzle"."__drizzle_migrations" (hash, created_at) values ($1, $2)', [hash, when]);
  return 'marked';
}

// query(text, params) → rows, on a transaction the caller commits. `want` is the dumpSchema of the schema
// drizzle/0000_baseline builds. Compares it with the database's public schema (the v1 runner's schema_migrations aside)
// and throws a labelled diff on any difference, before anything is written; on parity, marks the baseline unless
// `check`. Returns { lines: schema lines compared, result: 'checked' | 'marked' | 'already-marked' }.
export async function adoptBaseline(query, migrationsFolder, want, { check = false } = {}) {
  const got = await dumpSchema(query, 'public', { exclude: ['schema_migrations'] });
  const missing = want.filter((l) => !got.includes(l));
  const extra = got.filter((l) => !want.includes(l));
  if (missing.length || extra.length) {
    throw new Error([
      `schema differs from drizzle/0000_baseline: ${missing.length} missing, ${extra.length} extra`,
      ...missing.map((l) => `- (baseline only) ${l}`),
      ...extra.map((l) => `+ (database only) ${l}`),
    ].join('\n'));
  }
  return { lines: got.length, result: check ? 'checked' : await markBaseline(query, migrationsFolder) };
}
