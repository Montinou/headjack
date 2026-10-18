import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importGraph, specifiers, escapesScan } from '../import-scanner.mjs';
import { makeDir } from '../helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('the CLI and the lib modules it imports use only node: built-ins and never load enrichment', async () => {
  const { files, external } = await importGraph('cli/headjack.mjs');
  assert.deepEqual(external.filter((s) => !s.startsWith('node:')), []);
  assert.ok(!files.includes('lib/enrich.mjs'));
  assert.ok(!files.includes('lib/db.mjs'), 'the CLI never reaches the database module');
});

test('cli/headjack runs cli/headjack.mjs', async () => {
  const launcher = await readFile(path.join(ROOT, 'cli/headjack'), 'utf8');
  assert.match(launcher, /^#!\/bin\/sh/);
  assert.match(launcher, /^exec node "\$root\/cli\/headjack\.mjs" "\$@"$/m);
});

test('the closure escape check flags computed imports, require( and createRequire, and not spaced literals', () => {
  for (const bad of ['await import(name);', 'await import( name );', "require('x');", 'require ("x");', "const r = createRequire(import.meta.url);", 'import(`./${x}.mjs`);', 'await import('])
    assert.ok(escapesScan(bad), bad);
  for (const good of ["await import('./x.mjs');", "await import( './x.mjs' );", 'await import( "./x.mjs" );', "const x = 1; // no escapes"])
    assert.ok(!escapesScan(good), good);
});

test('no file in the CLI closure has a non-literal import(), require( or createRequire', async () => {
  const { files } = await importGraph('cli/headjack.mjs');
  assert.ok(files.length > 30, 'the closure is not empty');
  const offenders = [];
  for (const f of files) {
    const src = await readFile(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (escapesScan(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'a computed specifier or a require escapes the static closure scan');
});

test('importGraph resolves from the root it is given', async () => {
  const root = await makeDir({ 'a.mjs': "import './sub/b.mjs';\nimport 'node:fs';", 'sub/b.mjs': "import x from 'left-pad';" });
  const { files, external } = await importGraph('a.mjs', { root });
  assert.deepEqual(files.sort(), ['a.mjs', 'sub/b.mjs']);
  assert.deepEqual(external.sort(), ['left-pad', 'node:fs']);
});

test('handlers get enrichment injected: neither they nor their imports load the AI SDK', async () => {
  const { files, external } = await importGraph('lib/handlers.mjs');
  assert.ok(!files.includes('lib/enrich.mjs'));
  assert.ok(!files.includes('lib/db.mjs'), 'handlers get the database injected, never import it');
  assert.deepEqual(external.filter((s) => !s.startsWith('node:')), []);
});

test('the import scanner sees static, re-export, side-effect and dynamic imports', () => {
  const src = [
    "import a from 'static-a';",
    "import { b } from './b.mjs';",
    "export { c } from 'reexport-c';",
    "import 'side-effect-d';",
    "import './side-effect-e.mjs';",
    "const f = await import('dynamic-f');",
    'const g = await import( "dynamic-g" );',
    'const h = await import(name);',
  ].join('\n');
  assert.deepEqual(specifiers(src).sort(), ['./b.mjs', './side-effect-e.mjs', 'dynamic-f', 'dynamic-g', 'reexport-c', 'side-effect-d', 'static-a']);
});

// Every file under `dir` (relative to the repo root) with one of `exts`.
async function sourceFiles(dir, exts) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) out.push(path.relative(ROOT, path.join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

test('only lib/app.mjs opens the app database pool, and only lib/db.mjs reads the database URLs', async () => {
  const files = [...(await sourceFiles('lib', ['.mjs'])), ...(await sourceFiles('app', ['.ts', '.tsx']))];
  const pools = [];
  const urls = [];
  for (const f of files) {
    const src = await readFile(path.join(ROOT, f), 'utf8');
    if (specifiers(src).includes('@neondatabase/serverless')) pools.push(f);
    if (/DATABASE_URL/.test(src)) urls.push(f);
  }
  assert.deepEqual(pools, ['lib/app.mjs']);
  assert.deepEqual(urls, ['lib/db.mjs']);
});

test('route handlers only import lib/app.mjs, and handlers never see a pool', async () => {
  for (const f of await sourceFiles('app/api', ['.ts'])) {
    const specs = specifiers(await readFile(path.join(ROOT, f), 'utf8'));
    assert.deepEqual(specs.map((s) => path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, f)), s))), ['lib/app.mjs'], f);
  }
  const { files } = await importGraph('lib/handlers.mjs');
  assert.ok(!files.includes('lib/db.mjs') && !files.includes('lib/app.mjs'));
});
