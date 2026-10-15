// Imports skill-audit results: sets skills.quality and merges suggested_tags for VAULT / VAULT_AFTER_FIX rows.
//   node scripts/import-audit.mjs <result.jsonl> [more.jsonl ...]
// Runs as the app role for one owner: HEADJACK_OWNER_ID, or the initial owner. Reads DATABASE_URL_APP, or
// DATABASE_URL + HEADJACK_APP_DB_PASSWORD, from the environment or .env.local.
import { readFile } from 'node:fs/promises';
import { openOwnerRepo } from '../lib/app.mjs';
import { importAudit, parseAuditJsonl } from '../lib/backfill.mjs';

try { process.loadEnvFile(new URL('../.env.local', import.meta.url)); } catch {} // values are never printed

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/import-audit.mjs <result.jsonl> [more.jsonl ...]'); process.exit(2); }
const rows = [];
for (const f of files) {
  const parsed = parseAuditJsonl(await readFile(f, 'utf8'));
  for (const e of parsed.errors) console.error(`${f}: ${e}`);
  if (parsed.errors.length) process.exit(2);
  rows.push(...parsed.rows);
}

let vault;
try { vault = await openOwnerRepo(process.env); } catch (e) { console.error(e.message); process.exit(2); }
try {
  console.log(`owner ${vault.ownerId}`);
  const out = await importAudit({ repo: vault.repo, rows, log: (m) => console.log(m) });
  console.log(`\nupdated: ${out.updated.length}  not in the vault: ${out.missing.length}  ignored (other verdict): ${out.ignored}  invalid: ${out.invalid.length}`);
  process.exitCode = out.invalid.length ? 1 : 0;
} finally {
  await vault.end();
}
