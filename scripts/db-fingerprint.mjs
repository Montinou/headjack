// Prints the vault fingerprint (row counts + digests of hashes and tarball bytes) of a branch as JSON.
// Usage: node scripts/db-fingerprint.mjs > before.json, with DATABASE_URL_OWNER set. Read that URL at a hidden prompt
// and export it inside ( ... ) rather than on the command line (docs/operations.md, step 4).
// Run before and after the migration; the two outputs must be identical.
import { fingerprint } from '../db/fingerprint.mjs';
import { describeUrl, ownerUrl, withOwnerRole } from '../db/owner.mjs';

let url;
try { url = ownerUrl(process.env); } catch (e) { console.error(e.message); process.exit(2); }
console.error(`source: ${describeUrl(url)}`); // stderr, so stdout stays the JSON that is diffed
console.log(JSON.stringify(await withOwnerRole(process.env, fingerprint, { readOnly: true }), null, 2));
