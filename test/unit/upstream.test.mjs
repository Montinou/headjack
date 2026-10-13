import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpstream, parseGithub, parseRefs, resolveHead } from '../../lib/upstream.mjs';

test('parseGithub handles .git, trailing slash and non-github', () => {
  assert.deepEqual(parseGithub('https://github.com/acme-labs/agent-skills.git'), { owner: 'acme-labs', repo: 'agent-skills' });
  assert.deepEqual(parseGithub('https://github.com/o/r/'), { owner: 'o', repo: 'r' });
  assert.equal(parseGithub('https://gitlab.com/o/r'), null);
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const INFO_REFS = `001e# service=git-upload-pack\n0000009b${A} HEAD\0multi_ack thin-pack\n003f${A} refs/heads/main\n003f${B} refs/heads/dev\n0000`;

test('parseRefs resolves HEAD and branches', () => {
  assert.equal(parseRefs(INFO_REFS, 'HEAD'), A);
  assert.equal(parseRefs(INFO_REFS, 'dev'), B);
  assert.throws(() => parseRefs(INFO_REFS, 'nope'), /ref nope not found/);
});

test('resolveHead uses the GitHub API for github urls', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init.headers]); return new Response(`${A}\n`); };
  assert.equal(await resolveHead({ kind: 'github', url: 'https://github.com/o/r.git', default_ref: 'HEAD' }, fetchImpl, 'tok'), A);
  assert.equal(calls[0][0], 'https://api.github.com/repos/o/r/commits/HEAD');
  assert.equal(calls[0][1].accept, 'application/vnd.github.sha');
  assert.equal(calls[0][1].authorization, 'Bearer tok');
});

test('resolveHead uses smart HTTP for other git urls and surfaces HTTP errors', async () => {
  const ok = async (url) => { assert.equal(url, 'https://git.example.com/r.git/info/refs?service=git-upload-pack'); return new Response(INFO_REFS); };
  assert.equal(await resolveHead({ kind: 'git', url: 'https://git.example.com/r.git', default_ref: 'dev' }, ok), B);
  const bad = async () => new Response('x', { status: 404 });
  await assert.rejects(resolveHead({ kind: 'git', url: 'https://git.example.com/r.git', default_ref: 'HEAD' }, bad), /git 404/);
});

// SSRF hardening: the cron fetches source URLs that come from manifests.
function recordingFetch(response = () => new Response(INFO_REFS)) {
  const calls = [];
  const fn = async (url, init) => { calls.push([url, init]); return response(url, init); };
  fn.calls = calls;
  return fn;
}

test('resolveHead rejects non-https upstream urls without fetching', async () => {
  for (const url of ['http://git.example.com/r.git', 'file:///etc/passwd', 'git@github.com:o/r.git', 'ssh://git' + '@github.com/o/r.git', 'http://github.com/o/r']) {
    const f = recordingFetch();
    await assert.rejects(resolveHead({ kind: 'git', url, default_ref: 'HEAD' }, f), (e) => e.message === `unsupported upstream url: ${url}`, url);
    await assert.rejects(resolveHead({ kind: 'github', url, default_ref: 'HEAD' }, f), /unsupported upstream url/, url);
    assert.equal(f.calls.length, 0, url);
  }
});

test('resolveHead rejects loopback, link-local and private IP literals and localhost', async () => {
  const blocked = [
    'https://127.0.0.1/r.git', 'https://127.10.0.1/r.git', 'https://[::1]/r.git', 'https://localhost/r.git', 'https://LOCALHOST./r.git',
    'https://169.254.169.254/latest', 'https://[fe80::1]/r.git', 'https://10.0.0.5/r.git', 'https://172.16.0.1/r.git',
    'https://172.31.255.255/r.git', 'https://192.168.1.1/r.git', 'https://2130706433/r.git', 'https://[::ffff:127.0.0.1]/r.git',
  ];
  for (const url of blocked) {
    const f = recordingFetch();
    await assert.rejects(resolveHead({ kind: 'git', url, default_ref: 'HEAD' }, f), /upstream host not allowed/, url);
    assert.equal(f.calls.length, 0, url);
  }
  for (const url of ['https://172.32.0.1/r.git', 'https://8.8.8.8/r.git', 'https://git.example.com/r.git']) {
    const f = recordingFetch();
    assert.equal(await resolveHead({ kind: 'git', url, default_ref: 'HEAD' }, f), A, url);
    assert.equal(f.calls.length, 1, url);
  }
});

test('resolveHead never follows redirects and treats 3xx as an error', async () => {
  const redirect = recordingFetch(() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }));
  await assert.rejects(
    resolveHead({ kind: 'git', url: 'https://git.example.com/r.git', default_ref: 'HEAD' }, redirect),
    (e) => e.message === 'upstream redirect 302 for https://git.example.com/r.git',
  );
  await assert.rejects(
    resolveHead({ kind: 'github', url: 'https://github.com/o/r', default_ref: 'HEAD' }, redirect),
    (e) => e.message === 'upstream redirect 302 for https://github.com/o/r',
  );
  assert.deepEqual(redirect.calls.map(([, init]) => init.redirect), ['manual', 'manual']);
});

test('resolveHead GitHub API path still works with manual redirects', async () => {
  const f = recordingFetch(() => new Response(`${B}\n`));
  assert.equal(await resolveHead({ kind: 'github', url: 'https://github.com/o/r', default_ref: 'dev' }, f, 'tok'), B);
  assert.equal(f.calls[0][0], 'https://api.github.com/repos/o/r/commits/dev');
  assert.equal(f.calls[0][1].redirect, 'manual');
  assert.equal(f.calls[0][1].headers.authorization, 'Bearer tok');
});

// --- checkUpstream: per-skill decision from the tree sha of the skill's own directory ---

const API = 'https://api.github.com/repos/o/r';
const C = 'c'.repeat(40); // last commit touching the path
const T1 = '1'.repeat(40);
const T2 = '2'.repeat(40);
const pathCommits = (ref, path) => `${API}/commits?sha=${ref}&path=${path}&per_page=1`;
const listing = (entries) => entries.map(([name, sha, type = 'dir']) => ({ name, path: name, sha, type }));

// Answers GitHub API URLs from `routes` (URL -> JSON body or HTTP status); unknown URLs are 404. Records every call.
function ghFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push([url, init]);
    const r = routes[url];
    if (r === undefined) return new Response('not found', { status: 404 });
    return typeof r === 'number' ? new Response('x', { status: r }) : Response.json(r);
  };
  fn.calls = calls;
  return fn;
}

const pathTarget = (over = {}) => ({ kind: 'github', url: 'https://github.com/o/r', default_ref: 'HEAD', commit_sha: A, source_path: 'skills/foo', ...over });

test('checkUpstream: path tree unchanged between the reviewed commit and the ref is not an update', async () => {
  const f = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }],
    [`${API}/contents/skills?ref=${A}`]: listing([['foo', T1], ['bar', T2]]),
    [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T1], ['bar', T1]]),
  });
  assert.deepEqual(await checkUpstream(pathTarget(), f, 'tok'), { latest: C, updateAvailable: false });
});

test('checkUpstream: path tree changed is an update', async () => {
  const f = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }],
    [`${API}/contents/skills?ref=${A}`]: listing([['foo', T1]]),
    [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T2]]),
  });
  assert.deepEqual(await checkUpstream(pathTarget(), f, 'tok'), { latest: C, updateAvailable: true });
});

test('checkUpstream: latest path commit equal to the reviewed commit makes no contents calls', async () => {
  const f = ghFetch({ [pathCommits('HEAD', 'skills/foo')]: [{ sha: A }] });
  assert.deepEqual(await checkUpstream(pathTarget(), f), { latest: A, updateAvailable: false });
  assert.equal(f.calls.length, 1);
});

test('checkUpstream: no reviewed commit is never an update and makes no tree calls', async () => {
  const f = ghFetch({ [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }] });
  assert.deepEqual(await checkUpstream(pathTarget({ commit_sha: null }), f), { latest: C, updateAvailable: false });
  assert.equal(f.calls.length, 1);
});

test('checkUpstream: reviewed commit gone (404) or path absent at it falls back to an update', async () => {
  const gone = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }],
    [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T1]]),
  });
  assert.deepEqual(await checkUpstream(pathTarget(), gone), { latest: C, updateAvailable: true });
  const addedLater = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }],
    [`${API}/contents/skills?ref=${A}`]: listing([['bar', T1]]),
    [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T1]]),
  });
  assert.deepEqual(await checkUpstream(pathTarget(), addedLater), { latest: C, updateAvailable: true });
});

test('checkUpstream: path missing at the ref throws', async () => {
  const noCommits = ghFetch({ [pathCommits('HEAD', 'skills/foo')]: [] });
  await assert.rejects(checkUpstream(pathTarget(), noCommits), (e) => e.message === 'path skills/foo not found at HEAD in https://github.com/o/r');
  const noEntry = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }],
    [`${API}/contents/skills?ref=${A}`]: listing([['foo', T1]]),
    [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T1, 'file'], ['bar', T1]]),
  });
  await assert.rejects(checkUpstream(pathTarget(), noEntry), (e) => e.message === 'path skills/foo not found at HEAD in https://github.com/o/r');
});

test('checkUpstream: a top-level path lists the repo root and segments are encoded', async () => {
  const f = ghFetch({
    [`${API}/commits?sha=dev&path=my%20skill&per_page=1`]: [{ sha: C }],
    [`${API}/contents?ref=${A}`]: listing([['my skill', T1]]),
    [`${API}/contents?ref=dev`]: listing([['my skill', T1]]),
  });
  assert.deepEqual(await checkUpstream(pathTarget({ default_ref: 'dev', source_path: 'my skill' }), f), { latest: C, updateAvailable: false });
  const g = ghFetch({
    [`${API}/commits?sha=HEAD&path=a%23b/c%3Fd&per_page=1`]: [{ sha: C }],
    [`${API}/contents/a%23b?ref=${A}`]: listing([['c?d', T1]]),
    [`${API}/contents/a%23b?ref=HEAD`]: listing([['c?d', T2]]),
  });
  assert.deepEqual(await checkUpstream(pathTarget({ source_path: 'a#b/c?d' }), g), { latest: C, updateAvailable: true });
});

test('checkUpstream: non-2xx GitHub responses throw', async () => {
  const f = ghFetch({ [pathCommits('HEAD', 'skills/foo')]: 500 });
  await assert.rejects(checkUpstream(pathTarget(), f), (e) => e.message === 'github 500 for https://github.com/o/r');
  const g = ghFetch({ [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }], [`${API}/contents/skills?ref=${A}`]: 403, [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T1]]) });
  await assert.rejects(checkUpstream(pathTarget(), g), (e) => e.message === 'github 403 for https://github.com/o/r');
});

const rootTarget = (over = {}) => pathTarget({ source_path: null, ...over });
const commitJson = (sha, tree) => ({ sha, commit: { tree: { sha: tree } } });

test('checkUpstream: repo-root skill compares the root tree of the reviewed commit and the ref', async () => {
  const same = ghFetch({ [`${API}/commits/HEAD`]: commitJson(B, T1), [`${API}/commits/${A}`]: commitJson(A, T1) });
  assert.deepEqual(await checkUpstream(rootTarget(), same, 'tok'), { latest: B, updateAvailable: false });
  const changed = ghFetch({ [`${API}/commits/HEAD`]: commitJson(B, T2), [`${API}/commits/${A}`]: commitJson(A, T1) });
  assert.deepEqual(await checkUpstream(rootTarget({ source_path: '' }), changed, 'tok'), { latest: B, updateAvailable: true });
});

test('checkUpstream: repo-root skill with no reviewed commit or at HEAD is not an update, without a reviewed-side call', async () => {
  const f = ghFetch({ [`${API}/commits/HEAD`]: commitJson(A, T1) });
  assert.deepEqual(await checkUpstream(rootTarget(), f), { latest: A, updateAvailable: false });
  assert.deepEqual(await checkUpstream(rootTarget({ commit_sha: null }), f), { latest: A, updateAvailable: false });
  assert.ok(f.calls.every(([u]) => u === `${API}/commits/HEAD`));
});

test('checkUpstream: repo-root skill whose reviewed commit is gone (404) is an update', async () => {
  const f = ghFetch({ [`${API}/commits/HEAD`]: commitJson(B, T1) });
  assert.deepEqual(await checkUpstream(rootTarget(), f), { latest: B, updateAvailable: true });
  const missingRef = ghFetch({});
  await assert.rejects(checkUpstream(rootTarget(), missingRef), (e) => e.message === 'github 404 for https://github.com/o/r');
});

test('checkUpstream: the cache shares listings across targets in the same repo, parent and ref', async () => {
  const f = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }],
    [pathCommits('HEAD', 'skills/bar')]: [{ sha: C }],
    [`${API}/contents/skills?ref=${A}`]: listing([['foo', T1], ['bar', T1]]),
    [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T1], ['bar', T2]]),
  });
  const cache = new Map();
  assert.deepEqual(await checkUpstream(pathTarget(), f, 'tok', cache), { latest: C, updateAvailable: false });
  assert.deepEqual(await checkUpstream(pathTarget({ source_path: 'skills/bar' }), f, 'tok', cache), { latest: C, updateAvailable: true });
  const count = (u) => f.calls.filter(([url]) => url === u).length;
  assert.equal(count(`${API}/contents/skills?ref=HEAD`), 1);
  assert.equal(count(`${API}/contents/skills?ref=${A}`), 1);
  assert.equal(f.calls.length, 4);
});

test('checkUpstream: a failed request fails only the targets that need that URL', async () => {
  const f = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: 502,
    [pathCommits('HEAD', 'skills/bar')]: [{ sha: A }],
  });
  const cache = new Map();
  await assert.rejects(checkUpstream(pathTarget(), f, undefined, cache), /github 502/);
  await assert.rejects(checkUpstream(pathTarget(), f, undefined, cache), /github 502/);
  assert.deepEqual(await checkUpstream(pathTarget({ source_path: 'skills/bar' }), f, undefined, cache), { latest: A, updateAvailable: false });
});

test('checkUpstream sends the token, user-agent and manual redirects on every GitHub call', async () => {
  const f = ghFetch({
    [pathCommits('HEAD', 'skills/foo')]: [{ sha: C }],
    [`${API}/contents/skills?ref=${A}`]: listing([['foo', T1]]),
    [`${API}/contents/skills?ref=HEAD`]: listing([['foo', T2]]),
    [`${API}/commits/HEAD`]: commitJson(B, T1),
    [`${API}/commits/${A}`]: commitJson(A, T2),
  });
  await checkUpstream(pathTarget(), f, 'tok');
  await checkUpstream(rootTarget(), f, 'tok');
  assert.equal(f.calls.length, 5);
  for (const [url, init] of f.calls) {
    assert.ok(url.startsWith('https://api.github.com/'), url);
    assert.equal(init.headers.authorization, 'Bearer tok', url);
    assert.equal(init.headers['user-agent'], 'headjack', url);
    assert.equal(init.redirect, 'manual', url);
  }
  const anon = ghFetch({ [pathCommits('HEAD', 'skills/foo')]: [{ sha: A }] });
  await checkUpstream(pathTarget(), anon);
  assert.equal(anon.calls[0][1].headers.authorization, undefined);
});

test('checkUpstream never fetches unsafe urls and refuses redirects', async () => {
  for (const url of ['http://github.com/o/r', 'file:///etc/passwd', 'https://127.0.0.1/r.git', 'https://[::1]/r.git', 'https://localhost/r.git']) {
    const f = recordingFetch();
    await assert.rejects(checkUpstream({ kind: 'github', url, default_ref: 'HEAD', commit_sha: A, source_path: 'skills/foo' }, f), /unsupported upstream url|upstream host not allowed/, url);
    await assert.rejects(checkUpstream({ kind: 'git', url, default_ref: 'HEAD', commit_sha: A, source_path: null }, f), /unsupported upstream url|upstream host not allowed/, url);
    assert.equal(f.calls.length, 0, url);
  }
  const redirect = recordingFetch(() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }));
  await assert.rejects(checkUpstream(pathTarget(), redirect), (e) => e.message === 'upstream redirect 302 for https://github.com/o/r');
});

test('checkUpstream keeps the smart-HTTP HEAD comparison for non-GitHub git sources', async () => {
  const f = recordingFetch();
  const git = { kind: 'git', url: 'https://git.example.com/r.git', default_ref: 'dev', source_path: 'skills/foo' };
  assert.deepEqual(await checkUpstream({ ...git, commit_sha: A }, f), { latest: B, updateAvailable: true });
  assert.deepEqual(await checkUpstream({ ...git, commit_sha: B }, f), { latest: B, updateAvailable: false });
  assert.deepEqual(await checkUpstream({ ...git, commit_sha: null }, f), { latest: B, updateAvailable: false });
  assert.ok(f.calls.every(([url]) => url === 'https://git.example.com/r.git/info/refs?service=git-upload-pack'));
  await assert.rejects(checkUpstream({ kind: 'github', url: 'https://gitlab.com/o/r', default_ref: 'HEAD', commit_sha: A }, f), /not a github url/);
});

test('checkUpstream: source_path "." (SKILL.md at the repo root) is the repo-root branch, exactly like null', async () => {
  const routes = { [`${API}/commits/HEAD`]: commitJson(B, T2), [`${API}/commits/${A}`]: commitJson(A, T1) };
  const dot = ghFetch(routes);
  const none = ghFetch(routes);
  assert.deepEqual(await checkUpstream(rootTarget({ source_path: '.' }), dot), { latest: B, updateAvailable: true });
  assert.deepEqual(await checkUpstream(rootTarget({ source_path: null }), none), { latest: B, updateAvailable: true });
  assert.deepEqual(dot.calls.map(([u]) => u), none.calls.map(([u]) => u));
});

test('checkUpstream: "." segments are dropped from source_path ("./a/./b" is "a/b")', async () => {
  const routes = {
    [pathCommits('HEAD', 'a/b')]: [{ sha: C }],
    [`${API}/contents/a?ref=${A}`]: listing([['b', T1]]),
    [`${API}/contents/a?ref=HEAD`]: listing([['b', T2]]),
  };
  const dotted = ghFetch(routes);
  const plain = ghFetch(routes);
  assert.deepEqual(await checkUpstream(pathTarget({ source_path: './a/./b' }), dotted), { latest: C, updateAvailable: true });
  assert.deepEqual(await checkUpstream(pathTarget({ source_path: 'a/b' }), plain), { latest: C, updateAvailable: true });
  assert.deepEqual(dotted.calls.map(([u]) => u), plain.calls.map(([u]) => u));
  await assert.rejects(checkUpstream(pathTarget({ source_path: './a/./c' }), ghFetch({ [pathCommits('HEAD', 'a/c')]: [] })),
    (e) => e.message === 'path a/c not found at HEAD in https://github.com/o/r');
});
