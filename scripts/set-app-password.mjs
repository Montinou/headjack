// Lets headjack_app log in on one branch with the password in HEADJACK_APP_DB_PASSWORD (never stored in git).
// Needs DATABASE_URL_OWNER and HEADJACK_APP_DB_PASSWORD in the environment. Do not put them on the command line: read
// both at a hidden prompt and export them inside ( ... ), then run `node scripts/set-app-password.mjs` there (README,
// "Give the app role a password").
// The role itself (NOLOGIN, no BYPASSRLS) is created by drizzle/0001_app_foundation.sql.
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { Client } from '@neondatabase/serverless';
import { describeUrl, ownerUrl, withOwnerRole } from '../db/owner.mjs';

// @neondatabase/serverless@1.1.0 types export escapeLiteral, but the named export is undefined at runtime.
const escapeLiteral = (s) => Client.prototype.escapeLiteral.call(null, s);

const MIN_LENGTH = 32; // Neon requires ≥ 60 bits of entropy; 32 random base64 characters carry ~190.
// 0001 creates the role only when absent, so a pre-existing one keeps whatever it had: any of these, or any role
// membership, could let the app step around RLS or the minimal grants.
const FORBIDDEN = { rolsuper: 'superuser', rolbypassrls: 'bypassrls', rolcreaterole: 'createrole', rolcreatedb: 'createdb', rolinherit: 'inherit' };

// Checks headjack_app, then gives it LOGIN PASSWORD. query(text) → rows, inside the caller's transaction.
export async function setAppPassword(query, password) {
  const [role] = await query(`select ${Object.keys(FORBIDDEN).join(', ')} from pg_roles where rolname = 'headjack_app'`);
  if (!role) throw new Error('role headjack_app does not exist: run npm run db:migrate on this branch first');
  const bad = Object.entries(FORBIDDEN).filter(([col]) => role[col]).map(([, name]) => name);
  if (bad.length) throw new Error(`headjack_app must not have ${bad.join(', ')}`);
  const memberOf = await query(`select r.rolname from pg_auth_members m
    join pg_roles r on r.oid = m.roleid join pg_roles a on a.oid = m.member
    where a.rolname = 'headjack_app' order by r.rolname`);
  if (memberOf.length) throw new Error(`headjack_app must not be a member of any role (${memberOf.map((r) => r.rolname).join(', ')})`);
  await query(`alter role headjack_app with login password ${escapeLiteral(password)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const password = process.env.HEADJACK_APP_DB_PASSWORD ?? '';
  if (password.length < MIN_LENGTH) { console.error(`HEADJACK_APP_DB_PASSWORD must be at least ${MIN_LENGTH} characters`); process.exit(2); }
  let url;
  try { url = ownerUrl(process.env); } catch (e) { console.error(e.message); process.exit(2); }
  try {
    await withOwnerRole(process.env, (query) => setAppPassword(query, password));
  } catch (e) {
    // Driver errors can quote their input: never echo the connection string or the password. A refused WebSocket
    // connection arrives as an ErrorEvent with an empty message, which would leave the operator with no reason.
    const reason = e?.message || (e?.type ? `could not connect to the owner database (${e.type})` : String(e));
    console.error(reason.replaceAll(url, '<DATABASE_URL_OWNER>').replaceAll(password, '<password>'));
    process.exit(1);
  }
  console.log(`headjack_app can log in on ${describeUrl(url).replace(/^[^@]*@/, '')}`);
}
