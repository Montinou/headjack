// Only applied migration history and the tests that replay or assert it may name the former projects.
// The words are built from parts so this file never matches itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORDS = [['skill', 'vault'].join(''), ['epi', 'stek'].join('')];

const ALLOWED = [
  /^drizzle\/000[1-8]_[a-z0-9_]+\.sql$/,
  /^drizzle\/meta\/000[1-8]_snapshot\.json$/,
  /^drizzle\/0009_rename_app_role\.sql$/,
  /^test\/db\/foundation\.test\.mjs$/,
  /^test\/db\/migrations\.test\.mjs$/,
  /^test\/db\/rename-app-role\.test\.mjs$/,
  /^test\/unit\/removed-options\.test\.mjs$/,
];

test('no tracked file outside the history allowlist names the old projects', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length > 100, 'git ls-files returned a plausible tree');
  const hits = [];
  for (const file of files) {
    if (ALLOWED.some((re) => re.test(file))) continue;
    let buf;
    try {
      buf = readFileSync(`${ROOT}${file}`);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // listed but deleted in the working tree
      throw err;
    }
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').toLowerCase().split('\n').forEach((line, i) => {
      if (WORDS.some((w) => line.includes(w))) hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
