// The chunk allow-lists of the retrieval eval (spec §10). searchVector filters an allow-list after its nearest-neighbour
// pool of min(4096, n) rows, so above 4096 chunks an allowed chunk can drop with no fallback: every allow-listed pair is
// then invalid and never scored. The vault handle is only read here; the CLI imports no npm package.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chunkSkill, readSkillInfo } from './skillmd.mjs';
import { unpack } from './tar.mjs';

export const SIDECAR_FILE = 'eval-tag-chunks.json';
const KINDS = new Set(['tags', 'frontmatter']);
const PAIRS = ['hybrid', 'hybrid-meta', 'hybrid-meta-tags'];
const POOL_LIMIT = 4096;
const MISSING_SHARE_LIMIT = 0.05;
const NAME_CHUNK_LIMIT = 1000;

// `dir` is the state directory. Returns null when the file is absent; a file that is not valid throws, so a damaged
// sidecar is never read as an empty one.
export function readSidecar(dir) {
  const file = path.join(dir, SIDECAR_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a JSON array`);
  parsed.forEach((entry, index) => {
    const ok = entry && typeof entry === 'object'
      && Number.isInteger(entry.skill_id) && Number.isInteger(entry.version_id) && Number.isInteger(entry.chunk_id)
      && KINDS.has(entry.kind);
    if (!ok) throw new Error(`${file} entry ${index} needs integer skill_id, version_id, chunk_id and a kind of tags or frontmatter`);
  });
  return parsed;
}

function allInvalid(reason) {
  return Object.fromEntries(PAIRS.map((pair) => [pair, reason]));
}

function vecTablePresent(db) {
  return db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n === 1;
}

// The text the backfill stores as chunk 0 of a skill. A skill with no archive or no root SKILL.md has no archive text:
// its text is the one publish-current stores, built from the skills row. An archive that cannot be unpacked has no
// expected text, so the skill counts as missing unless the sidecar names its frontmatter chunk.
export function expectedFrontmatter(skill, tarball) {
  if (tarball) {
    let files;
    try {
      files = unpack(Buffer.from(tarball));
    } catch {
      return null;
    }
    if (files.some((file) => file.path === 'SKILL.md')) return chunkSkill(readSkillInfo(files, skill.slug))[0];
  }
  return `${skill.name}: ${skill.description}`.slice(0, NAME_CHUNK_LIMIT);
}

// A sidecar entry holds while its chunk still exists for the skill's current version with the kind the script wrote:
// a query chunk for tags, a content chunk for frontmatter.
function entryHolds(db, entry) {
  const row = db.prepare(
    `select c.skill_id, c.version_id, c.kind, s.current_version_id
       from chunks c join skills s on s.id = c.skill_id where c.id = ?`,
  ).get(entry.chunk_id);
  if (!row) return false;
  return row.skill_id === entry.skill_id && row.version_id === entry.version_id
    && row.current_version_id === entry.version_id
    && row.kind === (entry.kind === 'tags' ? 'query' : 'content');
}

export function buildAllowLists({ db, sidecar, vecLoaded }) {
  const chunkCount = Number(db.prepare('select count(*) as n from chunks').get().n);
  const skills = db.prepare(
    'select id, slug, name, description, current_version_id as version_id from skills where current_version_id is not null order by id',
  ).all();
  const empty = () => ({ hybrid: new Set(), 'hybrid-meta': new Set(), 'hybrid-meta-tags': new Set() });
  // Without vectors no skill has a usable frontmatter chunk, and chunk_vecs is not read.
  if (!vecLoaded || !vecTablePresent(db)) {
    return { chunkCount, skillsWithoutFrontmatter: skills.length, skillCount: skills.length, lists: empty(), invalid: allInvalid('vec-unavailable') };
  }

  const entries = Array.isArray(sidecar) ? sidecar : null;
  const sidecarIds = new Set((entries ?? []).map((entry) => entry.chunk_id));
  const holding = new Map((entries ?? []).map((entry) => [entry.chunk_id, entryHolds(db, entry)]));
  const stale = entries !== null && [...holding.values()].some((ok) => !ok);

  const embedded = new Set(db.prepare('select rowid from chunk_vecs').all().map((row) => Number(row.rowid)));
  const chunks = db.prepare('select id, kind from chunks order by id').all();
  const present = new Set(chunks.map((chunk) => chunk.id));
  const queryOutside = chunks.filter((chunk) => chunk.kind === 'query' && !sidecarIds.has(chunk.id)).map((chunk) => chunk.id);

  const frontmatter = new Set();
  let skillsWithoutFrontmatter = 0;
  const contentOf = db.prepare("select id, text from chunks where skill_id = ? and version_id = ? and kind = 'content' order by id");
  const tarballOf = db.prepare('select tarball from versions where id = ?');
  for (const skill of skills) {
    const expected = expectedFrontmatter(skill, tarballOf.get(skill.version_id)?.tarball ?? null);
    const candidates = contentOf.all(skill.id, skill.version_id)
      .filter((chunk) => chunk.text === expected || (sidecarIds.has(chunk.id) && holding.get(chunk.id)
        && entries.some((entry) => entry.chunk_id === chunk.id && entry.kind === 'frontmatter')))
      .map((chunk) => chunk.id);
    const chosen = candidates.find((id) => embedded.has(id));
    if (chosen === undefined) skillsWithoutFrontmatter++;
    else frontmatter.add(chosen);
  }

  const tagIds = (entries ?? []).filter((entry) => entry.kind === 'tags' && present.has(entry.chunk_id)).map((entry) => entry.chunk_id);
  const lists = {
    hybrid: new Set(chunks.map((chunk) => chunk.id).filter((id) => !sidecarIds.has(id))),
    'hybrid-meta': new Set([...frontmatter, ...queryOutside]),
    'hybrid-meta-tags': new Set([...tagIds, ...queryOutside]),
  };

  let invalid = {};
  if (chunkCount > POOL_LIMIT) {
    invalid = allInvalid('chunk-count-above-4096');
  } else {
    if (entries === null) invalid['hybrid-meta-tags'] = 'no-sidecar';
    else if (stale) invalid['hybrid-meta-tags'] = 'stale-sidecar';
    if (skills.length > 0 && skillsWithoutFrontmatter / skills.length > MISSING_SHARE_LIMIT) {
      invalid['hybrid-meta'] = 'frontmatter-missing-above-5-percent';
      invalid['hybrid-meta-tags'] ??= 'frontmatter-missing-above-5-percent';
    }
  }
  return { chunkCount, skillsWithoutFrontmatter, skillCount: skills.length, lists, invalid };
}
