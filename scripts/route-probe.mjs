// Checks that every v1 path is routed to its handler: with a wrong token each one must answer the v1 401 JSON body,
// including slugs with '.', '@' and ':'. Needs no database (the token check comes first).
//   node scripts/route-probe.mjs <base-url> [extra header name:value]
const [base, extra] = process.argv.slice(2);
if (!base) { console.error('usage: node scripts/route-probe.mjs <base-url> [header:value]'); process.exit(2); }
const extraHeaders = extra ? { [extra.slice(0, extra.indexOf(':'))]: extra.slice(extra.indexOf(':') + 1) } : {};
const UNAUTHORIZED = JSON.stringify({ error: { code: 'unauthorized', message: 'missing or invalid bearer token' } });
const probes = [
  ['GET', '/api/search?q=x'],
  ['GET', '/api/updates'],
  ['GET', '/api/cron/check-upstream'],
  ['POST', '/api/skills'],
  ['GET', '/api/skills/three.js'],
  ['GET', `/api/skills/${encodeURIComponent('noncore-plugin@example:nextjs')}`],
  ['GET', '/api/skills/three.js/download'],
  ['GET', `/api/skills/${encodeURIComponent('a@b')}/versions`],
];
let failed = 0;
for (const [method, path] of probes) {
  const res = await fetch(new URL(path, base), { method, headers: { authorization: 'Bearer wrong-token', ...extraHeaders }, redirect: 'manual' });
  const body = await res.text();
  const ok = res.status === 401 && body === UNAUTHORIZED && res.headers.get('content-type') === 'application/json';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${method} ${path} → ${res.status} ${ok ? '' : body.slice(0, 120)}`);
}
process.exit(failed ? 1 : 0);
