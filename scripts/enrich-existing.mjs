// Adds synthetic query chunks and tags to the current versions already in the vault (no new versions).
//   node scripts/enrich-existing.mjs [--dry-run] [--limit N] [--only slug1,slug2] [--force]
// Runs as the app role for one owner: HEADJACK_OWNER_ID, or the initial owner. Reads DATABASE_URL_APP (or
// DATABASE_URL + HEADJACK_APP_DB_PASSWORD) and the AI Gateway auth (VERCEL_OIDC_TOKEN or AI_GATEWAY_API_KEY) from
// the environment or .env.local.
import { openOwnerRepo } from '../lib/app.mjs';
import { embedTexts } from '../lib/embed.mjs';
import { enrichSkill, gatewayGenerate } from '../lib/enrich.mjs';
import { enrichExisting, parseBackfillArgs } from '../lib/backfill.mjs';

try { process.loadEnvFile(new URL('../.env.local', import.meta.url)); } catch {} // values are never printed

let opts;
try { opts = parseBackfillArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }

let vault;
try { vault = await openOwnerRepo(process.env); } catch (e) { console.error(e.message); process.exit(2); }
try {
  console.log(`owner ${vault.ownerId}`);
  const out = await enrichExisting({
    ...opts,
    repo: vault.repo,
    enrich: (skill) => enrichSkill(skill, { generate: gatewayGenerate }),
    embed: embedTexts,
    log: (m) => console.log(m),
  });
  console.log(`\n${opts.dryRun ? '(dry-run) ' : ''}enriched: ${out.enriched.length}  skipped: ${out.skipped.length}  failed: ${out.failed.length}`);
  process.exitCode = out.failed.length ? 1 : 0;
} finally {
  await vault.end();
}
