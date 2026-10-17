// `headjack pull` (spec §9): copies the user's approved hosted skills into the local vault. A standalone skill's tarball
// must hash to the hosted sha256, and its local version goes through the local publish path (files → chunks), like
// import. Plugins and plugin skills have no tarball (the download answers 409): they are stored from the detail
// metadata with one chunk, so they stay searchable. Local edits are never overwritten silently.
import { hashFiles } from '../lib/hash.mjs';
import { unpack } from '../lib/tar.mjs';
import { readSkillInfo, chunkSkill } from '../lib/skillmd.mjs';
import { SLUG_RE } from '../lib/handlers.mjs';
import { MAX_TARBALL_BYTES } from './api.mjs';

const PAGE_SIZE = 100; // the largest page GET /api/skills serves
// A hosted list that never ends (a broken total or offset) stops after this many pages: 100,000 skills.
export const MAX_PAGES = 1000;
// Unpacked size cap: an archive that inflates past this is refused, not buffered.
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
// The provenance of a pulled version: the local schema allows only github|git|marketplace|local, so a fixed local
// source marks what came from the hosted vault.
export const PULL_SOURCE = { kind: 'local', url: 'headjack:hosted' };
export const MISMATCH = 'sha256 mismatch';
export const editedLocally = (slug) => `edited locally and newer on hosted; run headjack pull --replace ${slug} to take hosted`;

// Every row of the hosted catalog, page by page. Stops at an empty page, at `total`, at a page that repeats the previous
// one when there is no numeric `total`, and after MAX_PAGES pages (logged).
async function hostedRows(hosted, log) {
  const rows = [];
  let previous = null;
  for (let offset = 0, pages = 0; ; pages += 1) {
    if (pages >= MAX_PAGES) {
      log(`stopped reading the hosted list after ${MAX_PAGES} pages`);
      return rows;
    }
    const page = await hosted.list({ limit: PAGE_SIZE, offset });
    const skills = Array.isArray(page?.skills) ? page.skills : [];
    if (!skills.length) return rows;
    const total = typeof page.total === 'number' ? page.total : null;
    const key = JSON.stringify(skills.map((r) => r?.slug));
    if (total === null && key === previous) return rows;
    previous = key;
    rows.push(...skills);
    offset += skills.length;
    if (total !== null && offset >= total) return rows;
  }
}

// `hosted`: the hosted api (createApi). `local`: the vault's { api, repo } (createLocalApi). `replace`: slugs whose hosted
// version wins over a local edit. Returns { pulled, unchanged, skipped: [{ slug, reason }], failed: [{ slug, reason }] }.
export async function pull({ hosted, local, replace = new Set(), log = () => {} }) {
  const report = { pulled: [], unchanged: [], skipped: [], failed: [] };
  const skip = (slug, reason) => { report.skipped.push({ slug, reason }); log(`skipped ${slug}: ${reason}`); };
  const fail = (slug, reason) => { report.failed.push({ slug, reason }); log(`failed ${slug}: ${reason}`); };

  const listed = new Set();
  for (const row of await hostedRows(hosted, log)) {
    // A slug the list repeats (a page boundary shifted) is handled once.
    if (typeof row?.slug === 'string') {
      if (listed.has(row.slug)) continue;
      listed.add(row.slug);
    }
    // Only approved skills are pulled; the rest are not mentioned, except a --replace naming one.
    if (row?.has_approved_version !== true) {
      if (replace.has(row?.slug)) { report.skipped.push({ slug: row.slug, reason: 'no approved version on hosted' }); log(`--replace ${row.slug}: no approved version on hosted`); }
      continue;
    }
    const slug = row.slug;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) { fail('<invalid slug>', 'invalid slug from the hosted vault'); continue; }
    try {
      const outcome = await pullSkill({ hosted, local, slug, replace: replace.has(slug) });
      if (outcome.skipped) skip(slug, outcome.skipped);
      else if (outcome.pulled) { report.pulled.push(slug); log(`pulled ${slug}`); }
      else report.unchanged.push(slug);
    } catch (e) {
      fail(slug, e?.message ?? String(e));
    }
  }
  for (const slug of replace) {
    if (listed.has(slug)) continue;
    report.skipped.push({ slug, reason: 'not on hosted' });
    log(`--replace ${slug}: not on hosted`);
  }
  return report;
}

// Spanish text of the local current version → the hosted one, when its enrichment_v differs. True when written.
async function syncSpanish(local, slug, detail, localSkill) {
  if ((detail.enrichment_v ?? null) === (localSkill.enrichment_v ?? null)) return false;
  // Hosted with no Spanish data never clears what the local vault has (a skill enriched locally keeps its text).
  if ((detail.enrichment_v ?? null) === null && localSkill.queries_es_text) return false;
  const [target] = await local.repo.listEnrichTargets({ slugs: [slug] });
  if (!target) throw new Error('the local skill has no current version');
  await local.repo.setSpanish(target.id, target.version_id, detail.queries_es_text ?? '', detail.enrichment_v ?? null);
  return true;
}

async function pullSkill({ hosted, local, slug, replace }) {
  const detail = await hosted.getSkill(slug);
  if (!detail) throw new Error('not found on the hosted vault');
  if (typeof detail.sha256 !== 'string' || !detail.sha256) throw new Error('the hosted vault has no approved version');
  const record = await local.repo.getPull(slug);
  const localSkill = await local.repo.getSkill(slug);
  const localSha = localSkill?.sha256 ?? null;

  // The local current version already is the hosted content: adopt it, whatever the pull record says. This also heals
  // a pull that stopped between publish, setSpanish and recordPull.
  if (localSkill && localSha === detail.sha256) {
    const spanish = await syncSpanish(local, slug, detail, localSkill);
    const recorded = record?.sha256 !== detail.sha256;
    if (recorded) await local.repo.recordPull(slug, detail.sha256);
    return { pulled: spanish || recorded };
  }

  if (localSkill) {
    // A slug with no pull record that exists locally counts as edited locally and newer on hosted.
    const edited = !record || localSha !== record.sha256;
    const hostedNewer = !record || detail.sha256 !== record.sha256;
    if (edited && hostedNewer && !replace) return { skipped: editedLocally(slug) };
    // An edit with nothing newer on hosted: the local version stays, Spanish included.
    if (edited && !replace) return { pulled: false };
  }

  // The only step that differs by kind: where the content comes from.
  const tags = Array.isArray(detail.tags) ? detail.tags : [];
  const standalone = detail.kind === 'skill' && !detail.plugin_slug;
  let tarball = null;
  let sha256 = detail.sha256;
  let info = { name: detail.name, description: detail.description };
  // Plugin rows take name, description and tags from the hosted detail; the re-point path below does not run the
  // manifest validation that publish does, so check them here.
  if (typeof info.name !== 'string' || !info.name.trim() || typeof info.description !== 'string' || !tags.every((t) => typeof t === 'string')) {
    throw new Error('the hosted detail has no valid name, description or tags');
  }
  let chunks;
  if (standalone) {
    ({ tarball } = await hosted.download(slug, { maxBytes: MAX_TARBALL_BYTES }));
    const files = unpack(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
    sha256 = hashFiles(files);
    if (sha256 !== detail.sha256) return { skipped: MISMATCH };
    info = readSkillInfo(files, slug);
    chunks = chunkSkill(info);
  } else {
    // No content to hash: a plugin's sha256 is an identity hash, stored as hosted gives it.
    chunks = [`${info.name}\n${info.description}\n${tags.join(' ')}`];
  }

  // A local import or review that landed since the check above wins: it is not replaced.
  if (((await local.repo.getSkill(slug))?.sha256 ?? null) !== localSha) return { skipped: editedLocally(slug) };

  let ids = null;
  if (localSkill && (await local.repo.versionExists(slug, sha256))) {
    // The vault already holds that content as an older version (--replace, or hosted rolled back): make it current.
    ids = await local.repo.setCurrentVersion({
      slug, sha256, name: info.name, description: info.description, tags,
      chunks: chunks.map((text) => ({ text, kind: 'content' })),
    });
    if (!ids) throw new Error('the vault holds this content as a rejected version; it is not made current');
  } else {
    ids = await local.api.publish({
      slug, name: info.name, description: info.description, kind: detail.kind, plugin_slug: detail.plugin_slug ?? null, tags,
      source: PULL_SOURCE, source_path: detail.source_path ?? null, commit_sha: detail.commit_sha ?? null, sha256,
      status: 'approved', review_notes: detail.review_notes ?? null,
      scan_flags: Array.isArray(detail.scan_flags) ? detail.scan_flags : [], chunks,
    }, tarball);
  }
  await local.repo.setSpanish(ids.skillId, ids.versionId, detail.queries_es_text ?? '', detail.enrichment_v ?? null);
  await local.repo.recordPull(slug, sha256);
  return { pulled: true };
}
