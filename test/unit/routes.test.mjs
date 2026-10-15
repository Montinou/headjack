import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Every v1 path (api/*.mjs before stage 1) keeps its method and handler under the App Router.
const V1_ROUTES = [
  ['app/api/search/route.ts', 'GET', 'search'],
  ['app/api/updates/route.ts', 'GET', 'updates'],
  ['app/api/cron/check-upstream/route.ts', 'GET', 'cron'],
  ['app/api/skills/route.ts', 'POST', 'publish'],
  ['app/api/skills/[slug]/route.ts', 'GET', 'getSkill'],
  ['app/api/skills/[slug]/download/route.ts', 'GET', 'download'],
  ['app/api/skills/[slug]/versions/route.ts', 'GET', 'versions'],
  ['app/api/events/install/route.ts', 'POST', 'installEvent'],
];

test('each v1 path has a route handler preserving its v1 method and handler, with catalog GET on skills', async () => {
  for (const [file, method, handler] of V1_ROUTES) {
    const src = await readFile(path.join(ROOT, file), 'utf8');
    const exported = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(exported, file === 'app/api/skills/route.ts' ? ['POST', 'GET'] : [method], file);
    if (file === 'app/api/skills/route.ts') assert.match(src, /return app\(\)\.listSkills\(req\);/);
    assert.match(src, new RegExp(`return app\\(\\)\\.${handler}\\(req\\);`), file);
    assert.doesNotMatch(src, /export const runtime/, `${file}: Node is the default runtime`);
  }
});

test('the plain Vercel functions are gone, so no path is served twice', async () => {
  await assert.rejects(access(path.join(ROOT, 'api')), { code: 'ENOENT' });
});

test('vercel.ts selects Next.js and keeps the weekly upstream cron', async () => {
  const { config } = await import('../../vercel.ts');
  assert.equal(config.framework, 'nextjs');
  assert.deepEqual(config.crons, [{ path: '/api/cron/check-upstream', schedule: '0 6 * * 1' }]);
});
