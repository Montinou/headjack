// Fills skills.queries_es_text (Spanish enrichment queries, feeds fts_es) for current versions that have none, with
// one model call per skill. Writes only that column and its enrichment_v: no chunks, tags or English side (spec §3.4).
//   node scripts/backfill-queries-es.mjs [--dry-run] [--limit N] [--only slug1,slug2] [--force] [--stale]
// --stale re-enriches rows whose enrichment_v is null or older than the current ENRICHMENT_VERSION (spec §6.3).
// --force overrides --stale (every current version). After a deploy, run the default mode as well as --stale: rows
// written by the old code during the build can hold '' with a version, which only the default mode picks up.
// Runs as the app role for one owner: HEADJACK_OWNER_ID, or the initial owner. Reads DATABASE_URL_APP (or
// DATABASE_URL + HEADJACK_APP_DB_PASSWORD) and the AI Gateway auth (VERCEL_OIDC_TOKEN or AI_GATEWAY_API_KEY) from
// the environment or .env.local. Prints slugs, counts and token usage; only --dry-run also prints each slug's generated
// queries (a quality sample: `--dry-run --limit 3`). Never prints secrets or env values.
import { openOwnerRepo } from '../lib/app.mjs';
import { ENRICH_ES_SCHEMA, enrichSpanish, gatewayGenerateWithUsage } from '../lib/enrich.mjs';
import { backfillQueriesEs, parseBackfillArgs } from '../lib/backfill.mjs';

try { process.loadEnvFile(new URL('../.env.local', import.meta.url)); } catch {} // values are never printed

let opts;
try { opts = parseBackfillArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }

const generate = (p) => gatewayGenerateWithUsage(p, { schema: ENRICH_ES_SCHEMA });

let vault;
try { vault = await openOwnerRepo(process.env); } catch (e) { console.error(e.message); process.exit(2); }
try {
  console.log(`owner ${vault.ownerId}`);
  const out = await backfillQueriesEs({
    ...opts,
    repo: vault.repo,
    enrichEs: (skill) => enrichSpanish(skill, { generate }),
    log: (m) => console.log(m),
  });
  const dry = opts.dryRun ? '(dry-run) ' : '';
  console.log(`\n${dry}with text before: ${out.before.withText}/${out.before.total}  after: ${out.after.withText}/${out.after.total}`);
  console.log(`${dry}filled: ${out.filled.length}  skipped: ${out.skipped.length}  failed: ${out.failed.length}`);
  console.log(`tokens: input ${out.usage.inputTokens}  output ${out.usage.outputTokens}`);
  process.exitCode = out.failed.length ? 1 : 0;
} finally {
  await vault.end();
}
