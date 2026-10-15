// Prints exposures, conversions and conversion rate per search-ranking variant (spec §3.5).
//   node scripts/ab-report.mjs
// Runs as the app role for one owner: HEADJACK_OWNER_ID, or the initial owner. Reads DATABASE_URL_APP, or
// DATABASE_URL + HEADJACK_APP_DB_PASSWORD, from the environment or .env.local.
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function reportLines(rows) {
  if (!rows.length) return ['no exposures recorded'];
  return rows.map(({ variant, exposures, conversions }) => {
    const rate = exposures ? (conversions / exposures) * 100 : 0;
    return `${variant}: ${exposures} exposures · ${conversions} conversions · rate ${rate.toFixed(1)}%`;
  });
}

// Runs only when invoked as a script, so tests can import reportLines() without a database.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try { process.loadEnvFile(new URL('../.env.local', import.meta.url)); } catch {} // values are never printed
  const { openOwnerRepo } = await import('../lib/app.mjs');
  let vault;
  try { vault = await openOwnerRepo(process.env); } catch (e) { console.error(e.message); process.exit(2); }
  try {
    console.log(`owner ${vault.ownerId}`);
    for (const line of reportLines(await vault.repo.conversionsByVariant())) console.log(line);
  } finally {
    await vault.end();
  }
}
