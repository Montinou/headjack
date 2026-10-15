// Asserts that no tracked file holds an instance value from the owner's deny list, case-insensitively. The terms come from
// HEADJACK_DENY_LIST (a CI secret, one term per line) when its trimmed value is non-empty, otherwise from the file named by
// PUBLIC_EXPORT_DENY or ~/.config/claude-methodology/public-export-deny.txt. With neither, the scan is skipped, never failed.
// The file set is `git ls-files` read on disk and must hold at least MIN_FILES files, so the scan cannot pass on an empty or
// shrunken list. A failure names <path>:<line> only, never a term or the matched text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hitMessage, parseDenyTerms, resolveDenySource, scanTree, trackedFiles } from '../deny-terms.mjs';
import { makeDir } from '../helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIN_FILES = 30;

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

const source = resolveDenySource({ env: process.env, home: homedir() });

// Terms built from parts so this file never holds a literal that could look like an instance value.
const PLANTED = ['zq', 'planted', 'term'].join('-');

test('parseDenyTerms trims, drops blank and # lines, and folds case', () => {
  assert.deepEqual(parseDenyTerms('a\n\n# c\n B '), ['a', 'b']);
  assert.deepEqual(parseDenyTerms('A\r\n  a \r\n#x\r\n'), ['a'], 'duplicates collapse and CRLF is handled');
  assert.deepEqual(parseDenyTerms(''), []);
});

test('HEADJACK_DENY_LIST counts only when its trimmed value is non-empty', async () => {
  const home = await makeDir({ '.config/claude-methodology/public-export-deny.txt': 'from-file\n' });
  const resolve = (env) => resolveDenySource({ env, home });
  assert.deepEqual(resolve({ HEADJACK_DENY_LIST: 'One\nTwo' }), { kind: 'env', terms: ['one', 'two'] });
  assert.equal(resolve({ HEADJACK_DENY_LIST: '' }).kind, 'file', 'an empty secret (a fork pull request) is absent');
  assert.equal(resolve({ HEADJACK_DENY_LIST: '  \n ' }).kind, 'file', 'a whitespace-only value is absent');
  assert.deepEqual(resolve({ HEADJACK_DENY_LIST: ' ', PUBLIC_EXPORT_DENY: '' }).terms, ['from-file']);
  assert.deepEqual(resolve({ HEADJACK_DENY_LIST: 'env-wins' }).terms, ['env-wins'], 'the variable beats the file');
});

test('PUBLIC_EXPORT_DENY names the file; a missing file and no variable is no source', async () => {
  const dir = await makeDir({ 'deny.txt': '# c\nX\n', 'home/.keep': '' });
  const home = `${dir}/home`;
  assert.deepEqual(resolveDenySource({ env: { PUBLIC_EXPORT_DENY: `${dir}/deny.txt` }, home }), { kind: 'file', terms: ['x'], path: `${dir}/deny.txt` });
  assert.equal(resolveDenySource({ env: { PUBLIC_EXPORT_DENY: `${dir}/absent.txt` }, home }), null);
  assert.equal(resolveDenySource({ env: {}, home }), null, 'neither a variable nor the default file: skip, not fail');
  assert.equal(resolveDenySource({ env: { HEADJACK_DENY_LIST: '\n\t' }, home }), null);
});

test('a planted term in a temp copy fails with path:line and without the term', async () => {
  const root = await makeDir({ 'a/clean.txt': 'nothing here\n', 'a/dirty.txt': `line one\nthe ${PLANTED.toUpperCase()} is here\n`, 'bin.dat': Buffer.from(`\0${PLANTED}`) });
  execFileSync('git', ['init', '-q'], { cwd: root, env: cleanEnv() });
  execFileSync('git', ['add', '-A'], { cwd: root, env: cleanEnv() });
  const hits = scanTree({ root, files: trackedFiles(root), terms: parseDenyTerms(PLANTED) });
  assert.deepEqual(hits, ['a/dirty.txt:2', 'bin.dat:1']);
  const message = hitMessage(hits);
  assert.ok(message.includes('a/dirty.txt:2'));
  assert.ok(!message.toLowerCase().includes(PLANTED), 'the message never holds the term');
  assert.deepEqual(scanTree({ root, files: ['a/clean.txt'], terms: parseDenyTerms(PLANTED) }), []);
});

test('no tracked file holds an instance value from the deny list', { skip: source ? false : 'no HEADJACK_DENY_LIST and no deny file: nothing to scan for' }, () => {
  assert.ok(source.terms.length > 0, 'the deny list holds no terms');
  const files = trackedFiles(ROOT);
  assert.ok(files.length >= MIN_FILES, `git lists ${files.length} files, fewer than ${MIN_FILES}`);
  const hits = scanTree({ root: ROOT, files, terms: source.terms });
  assert.deepEqual(hits, [], hitMessage(hits));
});
