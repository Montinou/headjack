// headjack pull (spec §9): approved standalone skills from a fake hosted api into a temporary local vault. No network
// except one loopback server for the spawned CLI; never the real ~/.headjack.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { localTest } from '../local-helpers.mjs';
import { captureLog, file, tempDir } from '../helpers.mjs';
import { hashFiles } from '../../lib/hash.mjs';
import { pack, unpack } from '../../lib/tar.mjs';
import { createLocalApi } from '../../lib/local/api.mjs';
import { pull } from '../../cli/pull.mjs';

const CLI = fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url));
const PAGE = 2; // the fake pages at 2 rows whatever limit is asked, so paging is exercised

const skillFiles = (slug, body = 'Use it.') => [
  file('SKILL.md', `---\nname: ${slug}\ndescription: ${slug} does things\n---\n# ${slug}\n${body}\n`),
  file('notes.txt', `${slug} notes ${body}`),
];

// A hosted vault: rows for GET /api/skills, details for GET /api/skills/{slug} and tarballs for the download.
function fakeHosted() {
  const skills = new Map();
  const calls = { list: [], getSkill: [], download: [] };
  return {
    calls,
    put(slug, { files = skillFiles(slug), approved = true, enrichment_v = null, queries_es_text = '', review_notes = 'reviewed: fine', scan_flags = ['net'], tags = ['audio'], tamper = null, kind = 'skill', plugin_slug = null, sha256 = null, description = `${slug} does things` } = {}) {
      // A plugin or plugin skill has no tarball: its sha256 is an identity hash and the download answers 409.
      const noTarball = kind !== 'skill' || plugin_slug !== null;
      const sha = approved ? (sha256 ?? hashFiles(files)) : null;
      skills.set(slug, { files, approved, tamper, noTarball, detail: {
        slug, name: slug, description, kind, plugin_slug, tags, quality: null,
        source_path: null, source_kind: 'github', source_url: `https://github.com/o/${slug}`, default_ref: 'HEAD',
        commit_sha: 'a'.repeat(40), sha256: sha, size: 10, reviewed_at: '2026-10-01T00:00:00.000Z',
        review_notes, scan_flags, update_available: false, latest_commit: null, queries_es_text, enrichment_v,
      } });
      return sha;
    },
    rawRow(row) { skills.set(row.slug, { row }); },
    async list({ limit = 50, offset = 0 } = {}) {
      calls.list.push({ limit, offset });
      const rows = [...skills.values()].map((s) => s.row ?? {
        slug: s.detail.slug, name: s.detail.name, description: s.detail.description, kind: s.detail.kind, plugin_slug: s.detail.plugin_slug,
        tags: s.detail.tags, quality: null, update_available: false, has_approved_version: s.approved,
      });
      return { skills: rows.slice(offset, offset + Math.min(limit, PAGE)), total: rows.length, limit, offset };
    },
    async getSkill(slug) {
      calls.getSkill.push(slug);
      return skills.get(slug)?.detail ?? null;
    },
    async download(slug) {
      calls.download.push(slug);
      const s = skills.get(slug);
      if (s.noTarball) throw Object.assign(new Error('this skill has no tarball'), { status: 409, code: 'conflict' });
      return { sha256: s.detail.sha256, tarball: pack(s.tamper ?? s.files) };
    },
  };
}

async function vault() {
  const dir = await tempDir('sv-pull-');
  const local = await createLocalApi({ dir });
  return { dir, local };
}

const run = (hosted, local, replace = []) => {
  const log = captureLog();
  return pull({ hosted, local, replace: new Set(replace), log }).then((r) => ({ ...r, log }));
};

// A local edit: a new approved version of `slug` published straight into the vault, as review or import would.
async function editLocally(local, slug, body) {
  const files = skillFiles(slug, body);
  await local.api.publish({
    slug, name: slug, description: `${slug} does things`, kind: 'skill', tags: [], source: { kind: 'local' },
    sha256: hashFiles(files), status: 'approved', review_notes: 'local edit', scan_flags: [], chunks: [`${slug}: edited`],
  }, pack(files));
  return hashFiles(files);
}

const editedMessage = (slug) => `edited locally and newer on hosted; run headjack pull --replace ${slug} to take hosted`;

localTest('a listed row without an approved version is skipped silently and never downloaded', async () => {
  const hosted = fakeHosted();
  hosted.put('draft', { approved: false });
  hosted.put('ready');
  const { local } = await vault();
  try {
    const r = await run(hosted, local);
    assert.deepEqual(r.pulled, ['ready']);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(hosted.calls.download, ['ready']);
    assert.equal(hosted.calls.getSkill.includes('draft'), false);
    assert.equal(await local.repo.getSkill('draft'), null);
    assert.equal(r.log.text().includes('draft'), false);
    // Named by --replace, the same row is reported instead of ignored.
    const named = await run(hosted, local, ['draft']);
    assert.deepEqual(named.skipped, [{ slug: 'draft', reason: 'no approved version on hosted' }]);
    assert.equal(hosted.calls.getSkill.includes('draft'), false);
  } finally {
    local.close();
  }
});

localTest('a new standalone skill is published locally with the hosted review, Spanish text and a pull record', async () => {
  const hosted = fakeHosted();
  const sha = hosted.put('mixer', { enrichment_v: 3, queries_es_text: 'mezclar pistas', review_notes: 'reviewed: careful', scan_flags: ['exec'] });
  const { local } = await vault();
  try {
    const r = await run(hosted, local);
    assert.deepEqual({ pulled: r.pulled, unchanged: r.unchanged, skipped: r.skipped, failed: r.failed }, { pulled: ['mixer'], unchanged: [], skipped: [], failed: [] });
    const skill = await local.repo.getSkill('mixer');
    assert.equal(skill.sha256, sha);
    assert.equal(skill.review_notes, 'reviewed: careful');
    assert.deepEqual(skill.scan_flags, ['exec']);
    assert.deepEqual(skill.tags, ['audio']);
    assert.equal(skill.queries_es_text, 'mezclar pistas');
    assert.equal(skill.enrichment_v, 3);
    const versions = await local.repo.listVersions('mixer');
    assert.deepEqual(versions.map((v) => [v.status, v.current]), [['approved', true]]);
    // The stored tarball is the hosted content, files intact.
    const { tarball } = await local.api.download('mixer');
    assert.equal(hashFiles(unpack(tarball)), sha);
    const record = await local.repo.getPull('mixer');
    assert.equal(record.sha256, sha);
    assert.match(record.pulled_at, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.match(r.log.text(), /pulled mixer/);
  } finally {
    local.close();
  }
});

localTest('a tarball whose content hash differs from the hosted sha256 is skipped and nothing is stored', async () => {
  const hosted = fakeHosted();
  hosted.put('evil', { tamper: skillFiles('evil', 'something else') });
  const { local } = await vault();
  try {
    const r = await run(hosted, local);
    assert.deepEqual(r.skipped, [{ slug: 'evil', reason: 'sha256 mismatch' }]);
    assert.deepEqual(r.pulled, []);
    assert.deepEqual(r.failed, []);
    assert.equal(await local.repo.getSkill('evil'), null);
    assert.equal(await local.repo.getPull('evil'), null);
    assert.match(r.log.text(), /skipped evil: sha256 mismatch/);
  } finally {
    local.close();
  }
});

localTest('same sha256 and same enrichment_v is unchanged; a newer hosted enrichment_v is written with setSpanish', async () => {
  const hosted = fakeHosted();
  hosted.put('mixer', { enrichment_v: 1, queries_es_text: 'mezclar' });
  const { local } = await vault();
  try {
    await run(hosted, local);
    const same = await run(hosted, local);
    assert.deepEqual({ pulled: same.pulled, unchanged: same.unchanged }, { pulled: [], unchanged: ['mixer'] });
    assert.deepEqual(hosted.calls.download, ['mixer'], 'an unchanged skill is not downloaded again');

    hosted.put('mixer', { enrichment_v: 2, queries_es_text: 'mezclar pistas de audio' });
    const enriched = await run(hosted, local);
    assert.deepEqual({ pulled: enriched.pulled, unchanged: enriched.unchanged }, { pulled: ['mixer'], unchanged: [] });
    const skill = await local.repo.getSkill('mixer');
    assert.equal(skill.queries_es_text, 'mezclar pistas de audio');
    assert.equal(skill.enrichment_v, 2);
    assert.equal((await local.repo.listVersions('mixer')).length, 1, 'no new version for a Spanish-only change');
    assert.deepEqual(hosted.calls.download, ['mixer'], 'a Spanish-only change downloads nothing');
  } finally {
    local.close();
  }
});

localTest('a local edit with a newer hosted version is skipped with the exact message; --replace takes hosted', async () => {
  const hosted = fakeHosted();
  hosted.put('mixer');
  const { local } = await vault();
  try {
    await run(hosted, local);
    const edited = await editLocally(local, 'mixer', 'my own change');

    // Hosted not newer than the pull record: the local edit is left alone.
    const quiet = await run(hosted, local);
    assert.deepEqual({ unchanged: quiet.unchanged, skipped: quiet.skipped }, { unchanged: ['mixer'], skipped: [] });
    assert.equal((await local.repo.getSkill('mixer')).sha256, edited);

    const newer = hosted.put('mixer', { files: skillFiles('mixer', 'hosted change') });
    const r = await run(hosted, local);
    assert.deepEqual(r.skipped, [{ slug: 'mixer', reason: editedMessage('mixer') }]);
    assert.deepEqual(r.pulled, []);
    assert.ok(r.log.lines.includes(`skipped mixer: ${editedMessage('mixer')}`), r.log.text());
    assert.equal((await local.repo.getSkill('mixer')).sha256, edited, 'the local edit is kept');

    const replaced = await run(hosted, local, ['mixer']);
    assert.deepEqual({ pulled: replaced.pulled, skipped: replaced.skipped }, { pulled: ['mixer'], skipped: [] });
    assert.equal((await local.repo.getSkill('mixer')).sha256, newer);
    assert.equal((await local.repo.getPull('mixer')).sha256, newer);
  } finally {
    local.close();
  }
});

localTest('a slug already in the vault with no pull record is skipped the same way, and --replace takes hosted', async () => {
  const hosted = fakeHosted();
  const sha = hosted.put('mixer');
  const { local } = await vault();
  try {
    const mine = await editLocally(local, 'mixer', 'imported locally');
    const r = await run(hosted, local);
    assert.deepEqual(r.skipped, [{ slug: 'mixer', reason: editedMessage('mixer') }]);
    assert.deepEqual(hosted.calls.download, [], 'nothing is downloaded for a skipped skill');
    assert.equal((await local.repo.getSkill('mixer')).sha256, mine);
    assert.equal(await local.repo.getPull('mixer'), null);

    const replaced = await run(hosted, local, ['mixer']);
    assert.deepEqual(replaced.pulled, ['mixer']);
    assert.equal((await local.repo.getSkill('mixer')).sha256, sha);
    assert.equal((await local.repo.getPull('mixer')).sha256, sha);
  } finally {
    local.close();
  }
});

localTest('--replace on a slug whose local content already equals hosted records the pull without a new version', async () => {
  const hosted = fakeHosted();
  const files = skillFiles('mixer');
  const sha = hosted.put('mixer', { files, enrichment_v: 2, queries_es_text: 'mezclar' });
  const { local } = await vault();
  try {
    await local.api.publish({
      slug: 'mixer', name: 'mixer', description: 'mixer does things', kind: 'skill', tags: [], source: { kind: 'local' },
      sha256: sha, status: 'approved', review_notes: 'imported', scan_flags: [], chunks: ['mixer: x'],
    }, pack(files));
    const r = await run(hosted, local, ['mixer']);
    assert.deepEqual(r.pulled, ['mixer']);
    assert.deepEqual(r.failed, []);
    assert.equal((await local.repo.listVersions('mixer')).length, 1);
    assert.equal((await local.repo.getPull('mixer')).sha256, sha);
    assert.equal((await local.repo.getSkill('mixer')).queries_es_text, 'mezclar');
  } finally {
    local.close();
  }
});

localTest('pages through the hosted list; a second run is all unchanged', async () => {
  const hosted = fakeHosted();
  for (const slug of ['alpha', 'beta', 'gamma']) hosted.put(slug, { enrichment_v: 1, queries_es_text: `${slug} es` });
  const { local } = await vault();
  try {
    const first = await run(hosted, local);
    assert.deepEqual(first.pulled.sort(), ['alpha', 'beta', 'gamma']);
    assert.ok(hosted.calls.list.length >= 2, 'more than one page was read');
    const second = await run(hosted, local);
    assert.deepEqual({ pulled: second.pulled, unchanged: second.unchanged.sort(), skipped: second.skipped, failed: second.failed },
      { pulled: [], unchanged: ['alpha', 'beta', 'gamma'], skipped: [], failed: [] });
  } finally {
    local.close();
  }
});

localTest('an invalid slug from hosted fails before the vault is touched; a failed download fails only that skill', async () => {
  const hosted = fakeHosted();
  hosted.rawRow({ slug: '../etc', kind: 'skill', plugin_slug: null, has_approved_version: true });
  hosted.put('broken');
  hosted.put('fine');
  const download = hosted.download;
  hosted.download = async (slug) => {
    if (slug === 'broken') throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return download(slug);
  };
  const { local } = await vault();
  try {
    const r = await run(hosted, local);
    assert.deepEqual(r.pulled, ['fine']);
    assert.deepEqual(r.failed.map((f) => f.slug), ['<invalid slug>', 'broken']);
    assert.equal(hosted.calls.getSkill.includes('../etc'), false);
    assert.equal(await local.repo.getSkill('broken'), null);
    assert.equal(await local.repo.getPull('broken'), null);
  } finally {
    local.close();
  }
});

// --- fix round 1 ---------------------------------------------------------------------------------------------------------

// A local copy of `local` whose repo method `name` throws on its first call only.
function failOnce(local, name) {
  let failed = false;
  const real = local.repo[name];
  return { ...local, repo: { ...local.repo, [name]: async (...a) => {
    if (!failed) { failed = true; throw new Error(`${name} crashed`); }
    return real(...a);
  } } };
}

localTest('identical local content with no pull record is adopted without --replace', async () => {
  const hosted = fakeHosted();
  const files = skillFiles('mixer');
  const sha = hosted.put('mixer', { files, enrichment_v: 2, queries_es_text: 'mezclar' });
  const { local } = await vault();
  try {
    await local.api.publish({
      slug: 'mixer', name: 'mixer', description: 'mixer does things', kind: 'skill', tags: [], source: { kind: 'local' },
      sha256: sha, status: 'approved', review_notes: 'imported', scan_flags: [], chunks: ['mixer: x'],
    }, pack(files));
    const r = await run(hosted, local);
    assert.deepEqual({ pulled: r.pulled, skipped: r.skipped }, { pulled: ['mixer'], skipped: [] });
    assert.deepEqual(hosted.calls.download, []);
    assert.equal((await local.repo.getPull('mixer')).sha256, sha);
    assert.equal((await local.repo.getSkill('mixer')).queries_es_text, 'mezclar');
    assert.equal((await local.repo.listVersions('mixer')).length, 1);
    assert.deepEqual((await run(hosted, local)).unchanged, ['mixer']);
  } finally {
    local.close();
  }
});

localTest('adopting identical content keeps Spanish text enriched locally when hosted has none', async () => {
  const hosted = fakeHosted();
  const files = skillFiles('mixer');
  const sha = hosted.put('mixer', { files, enrichment_v: null, queries_es_text: '' });
  const { local } = await vault();
  try {
    const { skillId, versionId } = await local.api.publish({
      slug: 'mixer', name: 'mixer', description: 'mixer does things', kind: 'skill', tags: [], source: { kind: 'local' },
      sha256: sha, status: 'approved', review_notes: 'imported', scan_flags: [], chunks: ['mixer: x'],
    }, pack(files));
    await local.repo.setSpanish(skillId, versionId, 'mezclar pistas', 1);
    const r = await run(hosted, local);
    assert.deepEqual(r.pulled, ['mixer']);
    const skill = await local.repo.getSkill('mixer');
    assert.equal(skill.queries_es_text, 'mezclar pistas');
    assert.equal(skill.enrichment_v, 1);
  } finally {
    local.close();
  }
});

localTest('a pull that crashed after publish (in setSpanish or recordPull) is healed by the next run', async () => {
  for (const step of ['setSpanish', 'recordPull']) {
    const hosted = fakeHosted();
    const sha = hosted.put('mixer', { enrichment_v: 2, queries_es_text: 'mezclar pistas' });
    const { local } = await vault();
    try {
      const crashed = await run(hosted, failOnce(local, step));
      assert.deepEqual(crashed.failed, [{ slug: 'mixer', reason: `${step} crashed` }], step);
      assert.equal(await local.repo.getPull('mixer'), null, step);
      const healed = await run(hosted, local);
      assert.deepEqual({ pulled: healed.pulled, skipped: healed.skipped, failed: healed.failed }, { pulled: ['mixer'], skipped: [], failed: [] }, step);
      const skill = await local.repo.getSkill('mixer');
      assert.equal(skill.queries_es_text, 'mezclar pistas', step);
      assert.equal(skill.enrichment_v, 2, step);
      assert.equal((await local.repo.getPull('mixer')).sha256, sha, step);
      assert.equal((await local.repo.listVersions('mixer')).length, 1, step);
    } finally {
      local.close();
    }
  }
});

localTest('a hosted rollback to content the vault holds as an older version makes that version current again', async () => {
  const hosted = fakeHosted();
  const shaA = hosted.put('mixer', { files: skillFiles('mixer', 'version A'), enrichment_v: 1, queries_es_text: 'versión a' });
  const { local } = await vault();
  try {
    await run(hosted, local);
    hosted.put('mixer', { files: skillFiles('mixer', 'version B') });
    assert.deepEqual((await run(hosted, local)).pulled, ['mixer']);
    hosted.put('mixer', { files: skillFiles('mixer', 'version A'), enrichment_v: 1, queries_es_text: 'versión a' });
    const r = await run(hosted, local);
    assert.deepEqual({ pulled: r.pulled, failed: r.failed }, { pulled: ['mixer'], failed: [] });
    const skill = await local.repo.getSkill('mixer');
    assert.equal(skill.sha256, shaA);
    assert.equal(skill.queries_es_text, 'versión a');
    assert.equal((await local.repo.listVersions('mixer')).length, 2, 'no new version row');
    assert.equal((await local.repo.getPull('mixer')).sha256, shaA);
    const { tarball } = await local.api.download('mixer');
    assert.equal(hashFiles(unpack(tarball)), shaA);
    // The search text follows the current version.
    assert.deepEqual((await (await local.route('http://headjack.local/api/search?q=version&k=5')).json()).results.map((x) => x.slug), ['mixer']);
    assert.deepEqual((await run(hosted, local)).unchanged, ['mixer']);
  } finally {
    local.close();
  }
});

localTest('--replace back to a pulled version the vault still holds re-points it; a rejected copy fails instead', async () => {
  const hosted = fakeHosted();
  const sha = hosted.put('mixer');
  const { local } = await vault();
  try {
    await run(hosted, local);
    await editLocally(local, 'mixer', 'my own change');
    const r = await run(hosted, local, ['mixer']);
    assert.deepEqual({ pulled: r.pulled, failed: r.failed }, { pulled: ['mixer'], failed: [] });
    assert.equal((await local.repo.getSkill('mixer')).sha256, sha);
    assert.equal((await local.repo.listVersions('mixer')).length, 2);

    const files = skillFiles('other');
    const otherSha = hosted.put('other', { files });
    await local.api.publish({
      slug: 'other', name: 'other', description: 'other does things', kind: 'skill', tags: [], source: { kind: 'local' },
      sha256: otherSha, status: 'rejected', review_notes: 'rejected locally', scan_flags: [], chunks: [],
    }, pack(files));
    const rejected = await run(hosted, local, ['other']);
    assert.deepEqual(rejected.failed, [{ slug: 'other', reason: 'the vault holds this content as a rejected version; it is not made current' }]);
    assert.equal((await local.repo.getSkill('other')).sha256, null);
  } finally {
    local.close();
  }
});

localTest('a local change that lands while a pull downloads is kept: the skill is skipped as edited locally', async () => {
  const hosted = fakeHosted();
  hosted.put('mixer');
  const { local } = await vault();
  try {
    await run(hosted, local);
    hosted.put('mixer', { files: skillFiles('mixer', 'hosted change') });
    let mine;
    const download = hosted.download;
    hosted.download = async (slug) => {
      mine = await editLocally(local, slug, 'concurrent import');
      return download(slug);
    };
    const r = await run(hosted, local);
    assert.deepEqual(r.skipped, [{ slug: 'mixer', reason: editedMessage('mixer') }]);
    assert.equal((await local.repo.getSkill('mixer')).sha256, mine);
  } finally {
    local.close();
  }
});

localTest('--replace with a slug the hosted list does not have is logged and counted as skipped', async () => {
  const hosted = fakeHosted();
  hosted.put('mixer');
  const { local } = await vault();
  try {
    const r = await run(hosted, local, ['ghost']);
    assert.deepEqual(r.pulled, ['mixer']);
    assert.deepEqual(r.skipped, [{ slug: 'ghost', reason: 'not on hosted' }]);
    assert.ok(r.log.lines.includes('--replace ghost: not on hosted'), r.log.text());
  } finally {
    local.close();
  }
});

localTest('the hosted list stops on a repeated page without total, and after MAX_PAGES pages', async () => {
  const { MAX_PAGES } = await import('../../cli/pull.mjs');
  const hosted = fakeHosted();
  hosted.put('mixer');
  const one = (await hosted.list()).skills;
  const { local } = await vault();
  try {
    let calls = 0;
    hosted.list = async () => { calls += 1; return { skills: one }; };
    assert.deepEqual((await run(hosted, local)).pulled, ['mixer']);
    assert.equal(calls, 2, 'the repeated page ends the list');

    calls = 0;
    hosted.list = async () => { calls += 1; return { skills: one, total: 1e9 }; };
    const capped = await run(hosted, local);
    assert.equal(calls, MAX_PAGES);
    assert.deepEqual(capped.unchanged, ['mixer'], 'a repeated slug is handled once');
    assert.ok(capped.log.lines.includes(`stopped reading the hosted list after ${MAX_PAGES} pages`), capped.log.text());
  } finally {
    local.close();
  }
});

localTest('a sha256 mismatch on an already-pulled skill leaves the pulled version current and the record as it was', async () => {
  const hosted = fakeHosted();
  const sha = hosted.put('mixer');
  const { local } = await vault();
  try {
    await run(hosted, local);
    const before = await local.repo.getPull('mixer');
    hosted.put('mixer', { files: skillFiles('mixer', 'hosted change'), tamper: skillFiles('mixer', 'swapped') });
    const r = await run(hosted, local);
    assert.deepEqual(r.skipped, [{ slug: 'mixer', reason: 'sha256 mismatch' }]);
    assert.equal((await local.repo.getSkill('mixer')).sha256, sha);
    assert.equal((await local.repo.listVersions('mixer')).length, 1);
    assert.deepEqual(await local.repo.getPull('mixer'), before);
  } finally {
    local.close();
  }
});

localTest('a skill edited locally keeps its own Spanish text when hosted only has a newer enrichment_v', async () => {
  const hosted = fakeHosted();
  hosted.put('mixer', { enrichment_v: 1, queries_es_text: 'hosted uno' });
  const { local } = await vault();
  try {
    await run(hosted, local);
    await editLocally(local, 'mixer', 'my own change');
    const [target] = await local.repo.listEnrichTargets({ slugs: ['mixer'] });
    await local.repo.setSpanish(target.id, target.version_id, 'mi texto', 1);
    hosted.put('mixer', { enrichment_v: 2, queries_es_text: 'hosted dos' });
    const r = await run(hosted, local);
    assert.deepEqual({ unchanged: r.unchanged, pulled: r.pulled }, { unchanged: ['mixer'], pulled: [] });
    const skill = await local.repo.getSkill('mixer');
    assert.equal(skill.queries_es_text, 'mi texto');
    assert.equal(skill.enrichment_v, 1);
  } finally {
    local.close();
  }
});

// --- the spawned CLI against a loopback hosted server -------------------------------------------------------------------

function serve(hosted, { failDownload = new Set() } = {}) {
  const server = createServer(async (req, res) => {
    const send = (status, body, headers = { 'content-type': 'application/json' }) => {
      res.writeHead(status, headers);
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: { code: 'unauthorized', message: 'no' } });
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/');
    if (url.pathname === '/api/skills') {
      return send(200, await hosted.list({ limit: Number(url.searchParams.get('limit')), offset: Number(url.searchParams.get('offset')) }));
    }
    const slug = decodeURIComponent(parts[3] ?? '');
    if (parts.length === 4) {
      const skill = await hosted.getSkill(slug);
      return skill ? send(200, { skill }) : send(404, { error: { code: 'not_found', message: 'none' } });
    }
    if (parts[4] === 'download') {
      if (failDownload.has(slug)) return send(500, { error: { code: 'internal', message: 'internal error' } });
      const { sha256, tarball } = await hosted.download(slug);
      return send(200, tarball, { 'content-type': 'application/gzip', 'x-skill-sha256': sha256 });
    }
    return send(404, { error: { code: 'not_found', message: 'no such route' } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

localTest('headjack pull: pulls into <state dir>/vault.db, exits 1 when an item failed, and needs HEADJACK_URL', async () => {
  const hosted = fakeHosted();
  const sha = hosted.put('mixer');
  hosted.put('broken');
  const server = await serve(hosted, { failDownload: new Set(['broken']) });
  const home = await tempDir('sv-pull-home-');
  const state = await tempDir('sv-pull-state-');
  const env = { HOME: home, HEADJACK_HOME: state, HEADJACK_TOKEN: 'test-token', HEADJACK_URL: `http://127.0.0.1:${server.address().port}` };
  try {
    const r = await runCli(['pull'], env);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /pulled mixer/);
    assert.match(r.stdout, /failed broken: internal error/);
    assert.match(r.stdout, /pulled: 1, unchanged: 0, skipped: 0, failed: 1/);

    const again = await runCli(['pull', '--replace', 'mixer'], { ...env });
    assert.match(again.stdout, /unchanged: 1/);

    const local = await createLocalApi({ dir: state });
    try {
      assert.equal((await local.repo.getSkill('mixer')).sha256, sha);
    } finally {
      local.close();
    }

    const bad = await runCli(['pull', '--replace', '../x'], env);
    assert.equal(bad.code, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /--replace/);

    const noUrl = await runCli(['pull'], { HOME: home, HEADJACK_HOME: state, HEADJACK_TOKEN: 'test-token' });
    assert.equal(noUrl.code, 2, noUrl.stdout + noUrl.stderr);
    assert.match(noUrl.stderr, /HEADJACK_URL is not set/);
  } finally {
    server.close();
  }
});

// --- plugins and plugin skills (download answers 409): stored from the detail metadata ---------------------------------------

const hex = (c) => c.repeat(64);
const PLUGIN_SKILL_NOTES = 'plugin skill: activated by enabling the plugin';
const searchSlugs = async (local, q) => (await local.repo.searchSignals(q, { limit: 10 })).map((r) => r.slug);

localTest('a plugin skill row is pulled without a download and found by searchSignals on a description word', async () => {
  const hosted = fakeHosted();
  const sha = hosted.put('p@m1:wrangle', {
    kind: 'skill', plugin_slug: 'p@m1', sha256: hex('b'), description: 'Wrangle quokkas across the outback',
    review_notes: PLUGIN_SKILL_NOTES, scan_flags: [], tags: ['marsupial'], enrichment_v: 2, queries_es_text: 'arrear quokkas',
  });
  const { local } = await vault();
  try {
    const r = await run(hosted, local);
    assert.deepEqual({ pulled: r.pulled, skipped: r.skipped, failed: r.failed }, { pulled: ['p@m1:wrangle'], skipped: [], failed: [] });
    assert.deepEqual(hosted.calls.download, [], 'no download is attempted for a plugin skill');

    const [hit] = await local.repo.searchSignals('quokkas outback', {});
    assert.equal(hit.slug, 'p@m1:wrangle');
    assert.equal(hit.review, 'unreviewed', 'notes starting with "plugin skill:" make it unreviewed');
    assert.equal(hit.kind, 'skill');
    assert.equal(hit.plugin_slug, 'p@m1');
    assert.deepEqual(await searchSlugs(local, 'marsupial'), ['p@m1:wrangle'], 'the tags are part of the one chunk');

    const skill = await local.repo.getSkill('p@m1:wrangle');
    assert.equal(skill.sha256, sha);
    assert.equal(skill.review_notes, PLUGIN_SKILL_NOTES);
    assert.deepEqual(skill.scan_flags, []);
    assert.equal(skill.queries_es_text, 'arrear quokkas');
    assert.equal(skill.enrichment_v, 2);
    assert.deepEqual((await local.repo.listVersions('p@m1:wrangle')).map((v) => [v.status, v.current]), [['approved', true]]);
    assert.equal((await local.repo.getPull('p@m1:wrangle')).sha256, sha);
    assert.match(r.log.text(), /pulled p@m1:wrangle/);
  } finally {
    local.close();
  }
});

localTest('a plugin row is pulled the same way; other hosted notes keep it approved', async () => {
  const hosted = fakeHosted();
  hosted.put('audio-tools@market', {
    kind: 'plugin', sha256: hex('c'), description: 'Mix and master audio', tags: ['sound'],
    review_notes: 'reviewed: careful', scan_flags: ['net'],
  });
  const { local } = await vault();
  try {
    const r = await run(hosted, local);
    assert.deepEqual({ pulled: r.pulled, failed: r.failed }, { pulled: ['audio-tools@market'], failed: [] });
    assert.deepEqual(hosted.calls.download, []);
    const [hit] = await local.repo.searchSignals('master audio', {});
    assert.equal(hit.slug, 'audio-tools@market');
    assert.equal(hit.kind, 'plugin');
    assert.equal(hit.review, 'approved');
    assert.deepEqual(await searchSlugs(local, 'sound'), ['audio-tools@market']);
    assert.deepEqual((await local.repo.getSkill('audio-tools@market')).scan_flags, ['net']);
  } finally {
    local.close();
  }
});

localTest('plugin rows follow the pull decision table: unchanged, Spanish sync, new hosted version, local edit, --replace', async () => {
  const hosted = fakeHosted();
  const put = (o = {}) => hosted.put('p@m1:wrangle', { kind: 'skill', plugin_slug: 'p@m1', review_notes: PLUGIN_SKILL_NOTES, scan_flags: [], ...o });
  put({ sha256: hex('b'), enrichment_v: 1, queries_es_text: 'arrear' });
  const { local } = await vault();
  try {
    await run(hosted, local);
    const same = await run(hosted, local);
    assert.deepEqual({ pulled: same.pulled, unchanged: same.unchanged }, { pulled: [], unchanged: ['p@m1:wrangle'] });

    put({ sha256: hex('b'), enrichment_v: 2, queries_es_text: 'arrear animales' });
    const spanish = await run(hosted, local);
    assert.deepEqual(spanish.pulled, ['p@m1:wrangle']);
    assert.equal((await local.repo.getSkill('p@m1:wrangle')).queries_es_text, 'arrear animales');
    assert.equal((await local.repo.listVersions('p@m1:wrangle')).length, 1);

    // A new hosted version, nothing edited locally: stored as a new current version, still without a download.
    put({ sha256: hex('d'), description: 'Herd wombats instead' });
    const newer = await run(hosted, local);
    assert.deepEqual(newer.pulled, ['p@m1:wrangle']);
    assert.equal((await local.repo.getSkill('p@m1:wrangle')).sha256, hex('d'));
    assert.deepEqual(await searchSlugs(local, 'wombats'), ['p@m1:wrangle']);
    assert.deepEqual(await searchSlugs(local, 'quokkas'), []);
    assert.equal((await local.repo.getPull('p@m1:wrangle')).sha256, hex('d'));

    // A local edit plus a newer hosted version is skipped; --replace takes hosted.
    await local.api.publish({
      slug: 'p@m1:wrangle', name: 'p@m1:wrangle', description: 'my own words', kind: 'skill', plugin_slug: 'p@m1', tags: [],
      source: { kind: 'local' }, sha256: hex('e'), status: 'approved', review_notes: 'local edit', scan_flags: [], chunks: ['my own words'],
    }, null);
    put({ sha256: hex('f'), description: 'Hosted moved on' });
    const skipped = await run(hosted, local);
    assert.deepEqual(skipped.skipped, [{ slug: 'p@m1:wrangle', reason: editedMessage('p@m1:wrangle') }]);
    assert.equal((await local.repo.getSkill('p@m1:wrangle')).sha256, hex('e'));
    const replaced = await run(hosted, local, ['p@m1:wrangle']);
    assert.deepEqual({ pulled: replaced.pulled, skipped: replaced.skipped }, { pulled: ['p@m1:wrangle'], skipped: [] });
    assert.equal((await local.repo.getSkill('p@m1:wrangle')).sha256, hex('f'));
    assert.equal((await local.repo.getPull('p@m1:wrangle')).sha256, hex('f'));
    assert.deepEqual(hosted.calls.download, []);
  } finally {
    local.close();
  }
});

localTest('a plugin row the vault rejects fails only that item and stores nothing', async () => {
  const hosted = fakeHosted();
  hosted.put('p@m1:broken', { kind: 'skill', plugin_slug: 'p@m1', sha256: 'not-a-hash', review_notes: PLUGIN_SKILL_NOTES });
  hosted.put('p@m1:fine', { kind: 'skill', plugin_slug: 'p@m1', sha256: hex('b'), review_notes: PLUGIN_SKILL_NOTES });
  const { local } = await vault();
  try {
    const r = await run(hosted, local);
    assert.deepEqual(r.pulled, ['p@m1:fine']);
    assert.deepEqual(r.failed.map((f) => f.slug), ['p@m1:broken']);
    assert.match(r.failed[0].reason, /sha256 must be 64 hex chars/);
    assert.equal(await local.repo.getSkill('p@m1:broken'), null);
    assert.equal(await local.repo.getPull('p@m1:broken'), null);
  } finally {
    local.close();
  }
});

localTest('headjack pull exits 1 when a plugin row failed', async () => {
  const hosted = fakeHosted();
  hosted.put('p@m1:broken', { kind: 'skill', plugin_slug: 'p@m1', sha256: 'not-a-hash', review_notes: PLUGIN_SKILL_NOTES });
  hosted.put('p@m1:fine', { kind: 'skill', plugin_slug: 'p@m1', sha256: hex('b'), review_notes: PLUGIN_SKILL_NOTES });
  const server = await serve(hosted);
  const home = await tempDir('sv-pull-home-');
  const state = await tempDir('sv-pull-state-');
  const env = { HOME: home, HEADJACK_HOME: state, HEADJACK_TOKEN: 'test-token', HEADJACK_URL: `http://127.0.0.1:${server.address().port}` };
  try {
    const r = await runCli(['pull'], env);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /pulled p@m1:fine/);
    assert.match(r.stdout, /failed p@m1:broken: /);
    assert.match(r.stdout, /pulled: 1, unchanged: 0, skipped: 0, failed: 1/);
  } finally {
    server.close();
  }
});

