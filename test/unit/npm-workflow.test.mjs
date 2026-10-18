// Text-level checks of the npm publish workflow (the repository has no YAML parser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = await readFile(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8').catch(() => '');
// The workflow-level header, the test job and the publish job, cut at their top-level keys.
const at = (marker) => text.indexOf(marker);
const header = text.slice(0, at('\njobs:'));
const testJob = text.slice(at('\n  test:'), at('\n  publish:'));
const publishJob = text.slice(at('\n  publish:'));

// Asserts the markers appear in `section` in this order.
function inOrder(section, markers) {
  let from = -1;
  for (const m of markers) {
    const next = section.indexOf(m, from + 1);
    assert.ok(next > from, `${m} appears after the previous step`);
    from = next;
  }
}

test('the workflow runs on a v tag with OIDC and no token', () => {
  assert.ok(text, 'npm-publish.yml exists');
  assert.match(text, /\btags:\s*\[\s*'v\*'\s*\]|\btags:\s*\n\s*-\s*'v\*'/);
  assert.match(text, /node-version:\s*24\b/);
  assert.match(text, /fetch-depth:\s*0\b/);
  for (const banned of ['NODE_AUTH_TOKEN', 'secrets.', '_authToken', 'cache:']) assert.ok(!text.includes(banned), banned);
});

test('only the publish job can mint an OIDC token, and it runs no dependency code', () => {
  assert.ok(at('\n  test:') > 0 && at('\n  publish:') > at('\n  test:'), 'a test job, then a publish job');
  assert.match(header, /^\s*contents:\s*read\s*$/m);
  assert.ok(!header.includes('id-token'), 'no workflow-wide id-token');
  assert.ok(!testJob.includes('id-token'), 'the test job has no id-token');
  assert.match(publishJob, /^\s*id-token:\s*write\s*$/m);
  assert.match(publishJob, /^\s*contents:\s*read\s*$/m);
  assert.match(publishJob, /needs:\s*test\b/);
  for (const job of [testJob, publishJob]) assert.match(job, /if:\s*github\.repository\s*==\s*'Montinou\/headjack'/);
  for (const dependencyCode of ['npm ci', 'npm install ', 'npm test', 'npm run']) {
    assert.ok(!publishJob.replace('npm install -g npm@11', '').includes(dependencyCode), `the publish job runs no ${dependencyCode}`);
  }
});

test('the steps run guard, version check, tests, then npm upgrade, pack and publish in order', () => {
  inOrder(testJob.slice(testJob.indexOf('steps:')), [
    'merge-base --is-ancestor',
    'npm/package.json',
    '.claude-plugin/plugin.json',
    'npm ci',
    'npm run test:unit',
  ]);
  assert.match(testJob, /"v\$\{?version\}?"|v\$\{version\}|"v\$version"/, 'the tag is compared with v<version>');
  const steps = publishJob.slice(publishJob.indexOf('steps:'));
  inOrder(steps, ['npm install -g npm@11', 'node scripts/pack-npm.mjs "$RUNNER_TEMP/pkg"', 'npm publish --access public']);
  assert.match(steps, /11\.5\.1/, 'npm is upgraded only below 11.5.1');
  const publish = steps.slice(steps.indexOf('npm publish --access public') - 200);
  assert.match(publish, /working-directory:\s*\$\{\{\s*runner\.temp\s*\}\}\/pkg/, 'publish runs from the pack output');
});

test('actions are pinned by commit SHA', () => {
  const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4, 'checkout and setup-node in both jobs');
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});
