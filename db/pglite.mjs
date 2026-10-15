// PGlite + pgvector helpers shared by the tests and scripts/db-baseline.mjs (dev dependencies only).
// PGlite supports CREATE ROLE, SET ROLE and FORCE ROW LEVEL SECURITY, so app-role tests run against the real policies.
import { cp, mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

export const MIGRATIONS = fileURLToPath(new URL('../drizzle/', import.meta.url));
export const V1_MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url));

export const newPg = () => PGlite.create({ extensions: { vector } });
export const rowsOf = (pg) => (text, params) => pg.query(text, params).then((r) => r.rows);
// Closes PGlite instances (tests call it once they are done with them; closing twice is harmless).
export const closePg = (...pgs) => Promise.all(pgs.map((pg) => (pg.closed ? undefined : pg.close())));

// Applies drizzle/ migrations up to and including the one whose tag starts with `lastPrefix` (all when omitted).
export async function migrateThrough(pg, lastPrefix) {
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
  const end = lastPrefix ? journal.entries.findIndex((e) => e.tag.startsWith(lastPrefix)) + 1 : journal.entries.length;
  if (end === 0) throw new Error(`no migration starting with ${lastPrefix}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'sv-mig-'));
  try {
    await mkdir(path.join(dir, 'meta'));
    for (const e of journal.entries.slice(0, end)) await cp(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, end) }));
    await migrate(drizzle(pg), { migrationsFolder: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function migratedPg() {
  const pg = await newPg();
  await migrateThrough(pg);
  return pg;
}
