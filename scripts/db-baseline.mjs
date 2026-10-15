// Adopts drizzle on a database that the v1 runner built (production, or a Neon branch of it):
//   1. dumps its public schema and the schema drizzle/0000_baseline builds in PGlite, and stops on any difference;
//   2. records 0000_baseline as applied in drizzle.__drizzle_migrations, without running it.
// Usage: node scripts/db-baseline.mjs [--check], with DATABASE_URL_OWNER set. Read that URL at a hidden prompt and export
// it inside ( ... ) rather than on the command line (docs/operations.md, step 4).
// --check stops after step 1 inside a read-only transaction. Safe to re-run: step 2 is a no-op once recorded.
import { dumpSchema } from '../db/catalog.mjs';
import { adoptBaseline } from '../db/baseline.mjs';
import { describeUrl, ownerUrl, withOwnerRole } from '../db/owner.mjs';
import { closePg, migrateThrough, newPg, rowsOf, MIGRATIONS } from '../db/pglite.mjs';

const check = process.argv.includes('--check');
let url;
try { url = ownerUrl(process.env); } catch (e) { console.error(e.message); process.exit(2); }
console.log(`target: ${describeUrl(url)}`);

const expected = await newPg();
let want;
try {
  await migrateThrough(expected, '0000_');
  want = await dumpSchema(rowsOf(expected));
} finally {
  await closePg(expected);
}

const { lines, result } = await withOwnerRole(process.env, (query) => adoptBaseline(query, MIGRATIONS, want, { check }), { readOnly: check });
console.log(`parity ok: ${lines} schema lines match drizzle/0000_baseline`);
console.log(result);
