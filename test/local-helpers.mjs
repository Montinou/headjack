// Local-mode tests run only on a Node whose bundled SQLite has FTS5; elsewhere they skip with the reason, so `npm test`
// still passes on Node 20.9 to 22.15.
import { test } from 'node:test';
import * as fsp from 'node:fs/promises';
import { runtimeCheck } from '../lib/local/runtime.mjs';

let reason = '';
export const localSupported = runtimeCheck().then(
  () => true,
  (e) => { reason = e.message; return false; },
);

const supported = await localSupported;

export function localTest(name, fn) {
  return supported ? test(name, fn) : test.skip(`${name} (skipped: ${reason})`, fn);
}

// Zeroes every page after page 1 of a vault file (page 1 holds the schema, which opening reads), so the file still opens
// and the first query that touches a table fails with SQLITE_CORRUPT. Call it with the vault closed.
export async function zeroPagesAfterFirst(file) {
  const { DatabaseSync } = await runtimeCheck();
  const probe = new DatabaseSync(file);
  let pageSize;
  try {
    pageSize = probe.prepare('PRAGMA page_size').get().page_size;
  } finally {
    probe.close();
  }
  const handle = await fsp.open(file, 'r+');
  try {
    const { size } = await handle.stat();
    for (let at = pageSize; at < size; at += pageSize) await handle.write(Buffer.alloc(pageSize), 0, pageSize, at);
  } finally {
    await handle.close();
  }
}
