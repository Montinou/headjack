// Text-level checks of the npm publish workflow (the repository has no YAML parser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = await readFile(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8').catch(() => '');

test('the workflow runs on a v tag with OIDC and no token', () => {
  assert.ok(text, 'npm-publish.yml exists');
  assert.match(text, /\btags:\s*\[\s*'v\*'\s*\]|\btags:\s*\n\s*-\s*'v\*'/);
  assert.match(text, /^\s*id-token:\s*write\s*$/m);
  assert.match(text, /^\s*contents:\s*read\s*$/m);
  assert.match(text, /if:\s*github\.repository\s*==\s*'Montinou\/headjack'/);
  assert.match(text, /node-version:\s*24\b/);
  assert.match(text, /fetch-depth:\s*0\b/);
  for (const banned of ['NODE_AUTH_TOKEN', 'secrets.', '_authToken', 'cache:']) assert.ok(!text.includes(banned), banned);
});

test('the steps run guard, version check, npm upgrade, tests, pack and publish in order', () => {
  const steps = text.slice(text.indexOf('steps:'));
  assert.ok(text.includes('steps:'));
  const markers = [
    'merge-base --is-ancestor',
    'npm/package.json',
    '.claude-plugin/plugin.json',
    'npm install -g npm@11',
    'npm ci',
    'npm run test:unit',
    'node scripts/pack-npm.mjs "$RUNNER_TEMP/pkg"',
    'npm publish --access public',
  ];
  let at = -1;
  for (const m of markers) {
    const next = steps.indexOf(m, at + 1);
    assert.ok(next > at, `${m} appears after the previous step`);
    at = next;
  }
  assert.match(steps, /11\.5\.1/, 'npm is upgraded only below 11.5.1');
  assert.match(steps, /"v\$\{?version\}?"|v\$\{version\}|"v\$version"/, 'the tag is compared with v<version>');
  const publish = steps.slice(steps.indexOf('npm publish --access public') - 200);
  assert.match(publish, /working-directory:\s*\$\{\{\s*runner\.temp\s*\}\}\/pkg/, 'publish runs from the pack output');
});

test('actions are pinned by commit SHA', () => {
  const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});
