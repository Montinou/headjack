import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { UserError } from '../../lib/errors.mjs';
import { localTest } from '../local-helpers.mjs';

localTest('runtimeCheck resolves with DatabaseSync on a Node whose SQLite has FTS5', async () => {
  const original = process.emitWarning;
  const { DatabaseSync } = await runtimeCheck();
  assert.equal(typeof DatabaseSync, 'function');
  const db = new DatabaseSync(':memory:');
  assert.equal({ ...db.prepare('select 1 as one').get() }.one, 1);
  db.close();
  assert.equal(process.emitWarning, original, 'process.emitWarning is restored');
});

test('runtimeCheck turns a failed load into a UserError naming the Node version and restores emitWarning', async () => {
  const original = process.emitWarning;
  await assert.rejects(
    runtimeCheck({ load: async () => { throw new Error('x'); } }),
    (e) => e instanceof UserError && /local mode needs a Node with SQLite FTS5/.test(e.message) && e.message.includes(`found ${process.version}`),
  );
  assert.equal(process.emitWarning, original);
});

test('runtimeCheck fails with the same UserError when the loaded SQLite has no FTS5', async () => {
  class NoFts {
    exec(sql) { if (/fts5/i.test(sql)) throw new Error('no such module: fts5'); }
    close() {}
  }
  await assert.rejects(runtimeCheck({ load: async () => ({ DatabaseSync: NoFts }) }), (e) => e instanceof UserError && /SQLite FTS5/.test(e.message));
});

test('runtimeCheck keeps the underlying failure as the cause, for a failed load and for a missing FTS5', async () => {
  const loadFailure = new Error('x');
  await assert.rejects(runtimeCheck({ load: async () => { throw loadFailure; } }), (e) => e instanceof UserError && e.cause === loadFailure);
  const probeFailure = new Error('no such module: fts5');
  class NoFts {
    exec() { throw probeFailure; }
    close() {}
  }
  await assert.rejects(runtimeCheck({ load: async () => ({ DatabaseSync: NoFts }) }), (e) => e instanceof UserError && e.cause === probeFailure);
});

test('runtimeCheck filters only the SQLite ExperimentalWarning raised during the load', async () => {
  const seen = [];
  const spy = (warning, type) => { seen.push([String(warning?.message ?? warning), typeof type === 'string' ? type : type?.type]); };
  const saved = process.emitWarning;
  process.emitWarning = spy;
  try {
    class Fake { exec() {} close() {} }
    await runtimeCheck({
      load: async () => {
        process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
        process.emitWarning('SQLite is an experimental feature and might change at any time', { type: 'ExperimentalWarning' });
        process.emitWarning('something else', 'DeprecationWarning');
        return { DatabaseSync: Fake };
      },
    });
    assert.deepEqual(seen, [['something else', 'DeprecationWarning']], 'other warnings pass through');
    assert.equal(process.emitWarning, spy, 'the wrapper is removed after the load');
  } finally {
    process.emitWarning = saved;
  }
});
