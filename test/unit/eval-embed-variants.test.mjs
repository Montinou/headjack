import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localTest } from '../local-helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';

// Every test uses temporary directories and a temporary HEADJACK_HOME; none touches the real ~/.headjack.
const temp = () => mkdtemp(path.join(os.tmpdir(), 'headjack-eval-embed-'));

// A vault in <dir>/vault.db with two skills (three chunks of their current versions), and an eval file at
// <dir>/suggest/eval.json.
async function sourceVault(dir) {
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    const repo = createSqliteRepo(db);
    for (const [slug, chunks] of [['alpha', ['alpha one', 'alpha two']], ['beta', ['beta one']]]) {
      const ids = await repo.publish({
        manifest: { slug, name: slug, description: 'description', kind: 'plugin', tags: [], source: { kind: 'local' }, sha256: slug.padEnd(64, '0'), status: 'approved' },
        tarball: null,
        chunks: chunks.map((text) => ({ text })),
      });
      await repo.replaceChunks({ skillId: ids.skillId, versionId: ids.versionId, contentChunks: chunks });
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  await mkdir(path.join(dir, 'suggest'), { recursive: true });
  await writeFile(path.join(dir, 'suggest', 'eval.json'), '[{"q":"from beside"}]');
}

async function harness() {
  const home = await temp();
  const from = await temp();
  const to = path.join(await temp(), 'copy');
  await sourceVault(from);
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); throw new Error('network must not be used'); };
  const logs = [];
  const base = { from: path.join(from, 'vault.db'), to, env: { HEADJACK_HOME: home }, fetchImpl, log: (s) => logs.push(s) };
  return { home, from, to, calls, logs, base };
}

async function run(options) {
  const { run: runScript } = await import('../../scripts/eval-embed-variants.mjs');
  return runScript(options);
}

localTest('refuses a --to inside the default state directory', async () => {
  const h = await harness();
  const inside = path.join(h.home, 'nested', 'copy');
  await assert.rejects(run({ ...h.base, to: inside }), (e) => e.exitCode === 2 && /state directory/.test(e.message));
  await assert.rejects(run({ ...h.base, to: h.home }), (e) => e.exitCode === 2);
  // a symlink into the state directory resolves to it
  const link = path.join(await temp(), 'link');
  await symlink(h.home, link);
  await assert.rejects(run({ ...h.base, to: path.join(link, 'copy') }), (e) => e.exitCode === 2);
  await assert.rejects(stat(path.join(h.home, 'nested')), { code: 'ENOENT' });
  assert.equal(h.calls.length, 0);
});

localTest('refuses a --to named with a leading ".." inside the default state directory', async () => {
  const h = await harness();
  const inside = path.join(h.home, '..copy');
  await assert.rejects(run({ ...h.base, to: inside }), (e) => e.exitCode === 2 && /state directory/.test(e.message));
  await assert.rejects(stat(inside), { code: 'ENOENT' });
  assert.equal(h.calls.length, 0);
});

localTest('refuses a --to that names the default state directory with different letter case', async (t) => {
  const h = await harness();
  const swapped = path.basename(h.home).replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const variant = path.join(path.dirname(h.home), swapped);
  // only a case-insensitive filesystem resolves the variant to the real directory
  if (!existsSync(variant)) return t.skip('the temp filesystem is case-sensitive');
  await assert.rejects(run({ ...h.base, to: path.join(variant, 'copy') }), (e) => e.exitCode === 2 && /state directory/.test(e.message));
  await assert.rejects(stat(path.join(h.home, 'copy')), { code: 'ENOENT' });
  assert.equal(h.calls.length, 0);
});

localTest('accepts a --from inside the default state directory and only reads it', async () => {
  const home = await temp();
  await sourceVault(home);
  const file = path.join(home, 'vault.db');
  const before = await readFile(file);
  const to = path.join(await temp(), 'copy');
  const result = await run({ from: file, to, env: { HEADJACK_HOME: home }, fetchImpl: async () => { throw new Error('no network'); }, log: () => {} });
  assert.equal(result.copied, true);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(path.join(to, 'suggest', 'eval.json'), 'utf8'), '[{"q":"from beside"}]');
});

localTest('takes the eval file from --eval, else from beside --from', async () => {
  const h = await harness();
  const other = path.join(await temp(), 'other-eval.json');
  await writeFile(other, '[{"q":"explicit"}]');
  await run({ ...h.base, evalFile: other });
  assert.equal(await readFile(path.join(h.to, 'suggest', 'eval.json'), 'utf8'), '[{"q":"explicit"}]');

  const second = path.join(await temp(), 'copy');
  await run({ ...h.base, to: second });
  assert.equal(await readFile(path.join(second, 'suggest', 'eval.json'), 'utf8'), '[{"q":"from beside"}]');
});

localTest('refuses an existing target vault', async () => {
  const h = await harness();
  await mkdir(h.to, { recursive: true });
  await writeFile(path.join(h.to, 'vault.db'), 'keep me');
  await assert.rejects(run(h.base), (e) => e.exitCode === 2 && /already exists/.test(e.message));
  assert.equal(await readFile(path.join(h.to, 'vault.db'), 'utf8'), 'keep me');
  await assert.rejects(stat(path.join(h.to, 'suggest')), { code: 'ENOENT' });
});

localTest('copies the vault and the eval file', async () => {
  const h = await harness();
  const result = await run(h.base);
  assert.equal(result.copied, true);
  const { DatabaseSync } = await runtimeCheck();
  const db = new DatabaseSync(path.join(h.to, 'vault.db'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('select slug from skills order by slug').all().map((r) => r.slug), ['alpha', 'beta']);
    assert.equal(db.prepare('select count(*) as n from chunks').get().n, 3);
  } finally {
    db.close();
  }
  assert.equal(await readFile(path.join(h.to, 'suggest', 'eval.json'), 'utf8'), '[{"q":"from beside"}]');
});

localTest('without --yes sends nothing and prints a text count', async () => {
  const h = await harness();
  const result = await run(h.base);
  assert.equal(result.texts, 3);
  assert.equal(h.calls.length, 0);
  assert.ok(h.logs.some((line) => /3 texts/.test(line)), h.logs.join('\n'));
});
