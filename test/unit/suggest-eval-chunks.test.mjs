// The chunk allow-lists of the retrieval eval and the sidecar the embed script writes (spec §10). Temporary vaults only;
// the real vault is never opened, and nothing here calls the network.
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { localSupported, localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { loadVec } from '../../lib/local/vec.mjs';
import { pack } from '../../lib/tar.mjs';
import { buildAllowLists, readSidecar } from '../../lib/suggest-eval-chunks.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};
const vector = [1, 0, ...Array(1534).fill(0)];
const PAIRS = ['hybrid', 'hybrid-meta', 'hybrid-meta-tags'];
const skillMd = (name, description, body = '') => Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
const archive = (files) => pack(files.map(([p, text]) => ({ path: p, mode: 0o644, data: Buffer.from(text) })));
const sorted = (set) => [...set].sort((a, b) => a - b);

// A vault with `loadVec` on. addSkill makes a current approved version; addChunk returns the new chunk id.
async function vault() {
  const db = openVault({ dir: await tempDir('sv-evalchunks-'), DatabaseSync, allowExtension: true });
  assert.equal(loadVec(db), true, 'vendored sqlite-vec must load');
  let next = 0;
  const api = {
    db,
    addSkill({ slug, name = slug, description = `${slug} does a thing`, tarball = null, kind = 'skill' }) {
      const id = ++next;
      db.prepare('insert into skills (id, slug, name, description, kind) values (?, ?, ?, ?, ?)').run(id, slug, name, description, kind);
      db.prepare("insert into versions (id, skill_id, sha256, status, reviewed_at, tarball) values (?, ?, ?, 'approved', '2020-01-01T00:00:00Z', ?)")
        .run(id, id, `sha-${slug}`, tarball);
      db.prepare('update skills set current_version_id = ? where id = ?').run(id, id);
      return id;
    },
    addChunk(skillId, text, kind = 'content', { vec = true } = {}) {
      const id = Number(db.prepare('insert into chunks (skill_id, version_id, text, kind) values (?, ?, ?, ?)').run(skillId, skillId, text, kind).lastInsertRowid);
      if (vec) db.prepare('insert into chunk_vecs (rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)').run(BigInt(id), JSON.stringify(vector), BigInt(skillId), BigInt(skillId));
      return id;
    },
  };
  return api;
}

// Three skills: A has an archive whose frontmatter differs from its row, B has no archive, C has an archive with no root
// SKILL.md. Each has a frontmatter chunk, a body chunk and an original query chunk; A and B also have a tag row.
async function standard() {
  const v = await vault();
  const a = v.addSkill({
    slug: 'alpha', name: 'Row Alpha', description: 'row description',
    tarball: archive([['SKILL.md', skillMd('alpha', 'archive description', '# Usage\n\nRun it.\n').toString()]]),
  });
  const b = v.addSkill({ slug: 'beta', name: 'Beta', description: 'Beta does a thing', kind: 'plugin' });
  const c = v.addSkill({ slug: 'gamma', name: 'Gamma', description: 'Gamma does a thing', tarball: archive([['docs/README.md', 'no root skill file']]) });
  const ids = {
    fmA: v.addChunk(a, 'alpha: archive description'), bodyA: v.addChunk(a, 'alpha — Usage: Run it.'), qA: v.addChunk(a, 'ejecutar alpha', 'query'),
    fmB: v.addChunk(b, 'Beta: Beta does a thing'), bodyB: v.addChunk(b, 'the whole body of beta'), qB: v.addChunk(b, 'ejecutar beta', 'query'),
    fmC: v.addChunk(c, 'Gamma: Gamma does a thing'), bodyC: v.addChunk(c, 'the whole body of gamma'), qC: v.addChunk(c, 'ejecutar gamma', 'query'),
  };
  ids.tagA = v.addChunk(a, 'alpha: archive description | tags: x', 'query');
  ids.tagB = v.addChunk(b, 'Beta: Beta does a thing | tags: y', 'query');
  const sidecar = [
    { skill_id: a, version_id: a, chunk_id: ids.tagA, kind: 'tags' },
    { skill_id: b, version_id: b, chunk_id: ids.tagB, kind: 'tags' },
  ];
  return { ...v, ids, sidecar, skills: { a, b, c } };
}

localTest('hybrid excludes every sidecar id', async () => {
  const f = await standard();
  try {
    const extra = f.addChunk(f.skills.c, 'Gamma: Gamma does a thing | extra', 'content');
    const sidecar = [...f.sidecar, { skill_id: f.skills.c, version_id: f.skills.c, chunk_id: extra, kind: 'frontmatter' }];
    const out = buildAllowLists({ db: f.db, sidecar, vecLoaded: true });
    const everything = f.db.prepare('select id from chunks').all().map((r) => r.id);
    assert.deepEqual(sorted(out.lists.hybrid), sorted(everything.filter((id) => ![f.ids.tagA, f.ids.tagB, extra].includes(id))));
    assert.equal(out.chunkCount, everything.length);
  } finally { f.db.close(); }
});

localTest('no sidecar invalidates hybrid-meta-tags and leaves the others valid', async () => {
  const f = await standard();
  try {
    const out = buildAllowLists({ db: f.db, sidecar: null, vecLoaded: true });
    assert.deepEqual(out.invalid, { 'hybrid-meta-tags': 'no-sidecar' });
    assert.equal(out.lists.hybrid.size, f.db.prepare('select count(*) n from chunks').get().n);
    assert.deepEqual(sorted(out.lists['hybrid-meta']), sorted([f.ids.fmA, f.ids.fmB, f.ids.fmC, f.ids.qA, f.ids.qB, f.ids.qC, f.ids.tagA, f.ids.tagB]));
    assert.equal(out.skillCount, 3);
    assert.equal(out.skillsWithoutFrontmatter, 0);
  } finally { f.db.close(); }
});

localTest('a valid sidecar gives the meta lists their definitions and no invalid pair', async () => {
  const f = await standard();
  try {
    const out = buildAllowLists({ db: f.db, sidecar: f.sidecar, vecLoaded: true });
    assert.deepEqual(out.invalid, {});
    assert.deepEqual(sorted(out.lists['hybrid-meta']), sorted([f.ids.fmA, f.ids.fmB, f.ids.fmC, f.ids.qA, f.ids.qB, f.ids.qC]));
    assert.deepEqual(sorted(out.lists['hybrid-meta-tags']), sorted([f.ids.tagA, f.ids.tagB, f.ids.qA, f.ids.qB, f.ids.qC]));
  } finally { f.db.close(); }
});

localTest('a deleted tag row invalidates only hybrid-meta-tags', async () => {
  const f = await standard();
  try {
    f.db.prepare('delete from chunks where id = ?').run(f.ids.tagB);
    f.db.prepare('delete from chunk_vecs where rowid = ?').run(BigInt(f.ids.tagB));
    const out = buildAllowLists({ db: f.db, sidecar: f.sidecar, vecLoaded: true });
    assert.deepEqual(out.invalid, { 'hybrid-meta-tags': 'stale-sidecar' });
    assert.equal(out.lists.hybrid.has(f.ids.tagA), false);
    assert.equal(out.lists['hybrid-meta'].has(f.ids.fmB), true);
  } finally { f.db.close(); }
});

localTest('a sidecar entry that no longer matches the current version or kind is stale', async () => {
  const f = await standard();
  try {
    const moved = f.sidecar.map((e, i) => (i === 0 ? { ...e, version_id: 99 } : e));
    assert.equal(buildAllowLists({ db: f.db, sidecar: moved, vecLoaded: true }).invalid['hybrid-meta-tags'], 'stale-sidecar');
    const wrongKind = f.sidecar.map((e, i) => (i === 0 ? { ...e, kind: 'frontmatter' } : e));
    assert.equal(buildAllowLists({ db: f.db, sidecar: wrongKind, vecLoaded: true }).invalid['hybrid-meta-tags'], 'stale-sidecar');
  } finally { f.db.close(); }
});

localTest('a skill with no archive takes its expected text from the skills row', async () => {
  const v = await vault();
  try {
    const s = v.addSkill({ slug: 'plug', name: 'Plug', description: 'x'.repeat(1500), kind: 'plugin' });
    const fm = v.addChunk(s, `Plug: ${'x'.repeat(1500)}`.slice(0, 1000));
    v.addChunk(s, 'the whole body as one chunk');
    const out = buildAllowLists({ db: v.db, sidecar: null, vecLoaded: true });
    assert.equal(out.skillsWithoutFrontmatter, 0);
    assert.deepEqual(sorted(out.lists['hybrid-meta']), [fm]);
    assert.deepEqual(out.invalid, { 'hybrid-meta-tags': 'no-sidecar' });
  } finally { v.db.close(); }
});

localTest('a tarball without SKILL.md falls back to the skills row', async () => {
  const f = await standard();
  try {
    const out = buildAllowLists({ db: f.db, sidecar: f.sidecar, vecLoaded: true });
    assert.equal(out.lists['hybrid-meta'].has(f.ids.fmC), true);
    assert.equal(out.skillsWithoutFrontmatter, 0);
    // The archive text, not the row text, is what a tarball skill is matched against.
    f.db.prepare('update chunks set text = ? where id = ?').run('Row Alpha: row description', f.ids.fmA);
    const after = buildAllowLists({ db: f.db, sidecar: f.sidecar, vecLoaded: true });
    assert.equal(after.lists['hybrid-meta'].has(f.ids.fmA), false);
    assert.equal(after.skillsWithoutFrontmatter, 1);
  } finally { f.db.close(); }
});

localTest('a frontmatter chunk without a vector counts as missing', async () => {
  const f = await standard();
  try {
    f.db.prepare('delete from chunk_vecs where rowid = ?').run(BigInt(f.ids.fmB));
    const out = buildAllowLists({ db: f.db, sidecar: f.sidecar, vecLoaded: true });
    assert.equal(out.skillsWithoutFrontmatter, 1);
    assert.equal(out.lists['hybrid-meta'].has(f.ids.fmB), false);
  } finally { f.db.close(); }
});

localTest('a sidecar frontmatter entry counts as the frontmatter chunk of a skill', async () => {
  const v = await vault();
  try {
    const s = v.addSkill({ slug: 'plain', name: 'Plain', description: 'Plain thing' });
    v.addChunk(s, 'the whole body as one chunk');
    const added = v.addChunk(s, 'Plain: Plain thing');
    const entry = { skill_id: s, version_id: s, chunk_id: added, kind: 'frontmatter' };
    const out = buildAllowLists({ db: v.db, sidecar: [entry], vecLoaded: true });
    assert.equal(out.skillsWithoutFrontmatter, 0);
    assert.deepEqual(sorted(out.lists['hybrid-meta']), [added]);
    assert.equal(out.lists.hybrid.has(added), false);
  } finally { v.db.close(); }
});

localTest('more than 5 percent missing invalidates both meta pairs', async () => {
  const v = await vault();
  try {
    for (let i = 0; i < 20; i++) {
      const s = v.addSkill({ slug: `s${i}` });
      v.addChunk(s, `s${i}: s${i} does a thing`, 'content', { vec: i !== 0 });
    }
    // 1 of 20 is exactly 5 percent: still valid.
    let out = buildAllowLists({ db: v.db, sidecar: [], vecLoaded: true });
    assert.equal(out.skillsWithoutFrontmatter, 1);
    assert.equal(out.skillCount, 20);
    assert.deepEqual(out.invalid, {});
    // 2 of 20 is 10 percent.
    v.db.prepare('delete from chunk_vecs where rowid = 2').run();
    out = buildAllowLists({ db: v.db, sidecar: [], vecLoaded: true });
    assert.equal(out.skillsWithoutFrontmatter, 2);
    assert.deepEqual(out.invalid, { 'hybrid-meta': 'frontmatter-missing-above-5-percent', 'hybrid-meta-tags': 'frontmatter-missing-above-5-percent' });
  } finally { v.db.close(); }
});

localTest('above 4096 chunks every allow-listed pair is invalid', async () => {
  const v = await vault();
  try {
    const s = v.addSkill({ slug: 'big' });
    v.addChunk(s, 'big: big does a thing');
    v.db.exec('BEGIN');
    const insert = v.db.prepare('insert into chunks (skill_id, version_id, text, kind) values (?, ?, ?, ?)');
    for (let i = 0; i < 4096; i++) insert.run(s, s, `filler ${i}`, 'content');
    v.db.exec('COMMIT');
    const out = buildAllowLists({ db: v.db, sidecar: [], vecLoaded: true });
    assert.equal(out.chunkCount, 4097);
    assert.deepEqual(out.invalid, Object.fromEntries(PAIRS.map((p) => [p, 'chunk-count-above-4096'])));
    // 4096 is still within the nearest-neighbour pool.
    v.db.prepare("delete from chunks where text = 'filler 0'").run();
    const ok = buildAllowLists({ db: v.db, sidecar: [], vecLoaded: true });
    assert.equal(ok.chunkCount, 4096);
    assert.deepEqual(ok.invalid, {});
  } finally { v.db.close(); }
});

localTest('a vault with no chunk_vecs table or vecLoaded false returns all pairs invalid with vec-unavailable and does not throw', async () => {
  const bare = openVault({ dir: await tempDir('sv-evalchunks-bare-'), DatabaseSync });
  try {
    bare.prepare("insert into skills (id, slug, name, description, kind) values (1, 's', 's', 'd', 'skill')").run();
    bare.prepare("insert into versions (id, skill_id, sha256, status, reviewed_at) values (1, 1, 'x', 'approved', '2020-01-01')").run();
    bare.prepare('update skills set current_version_id = 1 where id = 1').run();
    bare.prepare("insert into chunks (skill_id, version_id, text, kind) values (1, 1, 's: d', 'content')").run();
    const expected = Object.fromEntries(PAIRS.map((p) => [p, 'vec-unavailable']));
    for (const vecLoaded of [true, false]) {
      const out = buildAllowLists({ db: bare, sidecar: [], vecLoaded });
      assert.deepEqual(out.invalid, expected);
      for (const p of PAIRS) assert.equal(out.lists[p].size, 0);
      assert.equal(out.chunkCount, 1);
    }
  } finally { bare.close(); }
  // vecLoaded false on a vault that does have the table: chunk_vecs is not read at all.
  const f = await standard();
  try {
    const statements = [];
    const spy = { prepare: (sql) => { statements.push(sql); return f.db.prepare(sql); } };
    const out = buildAllowLists({ db: spy, sidecar: f.sidecar, vecLoaded: false });
    assert.deepEqual(out.invalid, Object.fromEntries(PAIRS.map((p) => [p, 'vec-unavailable'])));
    assert.equal(statements.some((s) => /chunk_vecs/.test(s) && !/sqlite_master/.test(s)), false);
  } finally { f.db.close(); }
});

// ---- the sidecar file ----

test('readSidecar returns null when the file is absent and the parsed array when present', async () => {
  const dir = await tempDir('sv-sidecar-');
  assert.equal(readSidecar(dir), null);
  const entries = [{ skill_id: 1, version_id: 2, chunk_id: 3, kind: 'tags' }, { skill_id: 1, version_id: 2, chunk_id: 4, kind: 'frontmatter' }];
  await fsp.writeFile(path.join(dir, 'eval-tag-chunks.json'), JSON.stringify(entries));
  assert.deepEqual(readSidecar(dir), entries);
});

test('readSidecar rejects a file that is not an array of well-formed entries', async () => {
  const dir = await tempDir('sv-sidecar-bad-');
  const file = path.join(dir, 'eval-tag-chunks.json');
  await fsp.writeFile(file, '{ not json');
  assert.throws(() => readSidecar(dir), /eval-tag-chunks\.json/);
  await fsp.writeFile(file, JSON.stringify({ skill_id: 1 }));
  assert.throws(() => readSidecar(dir), /array/);
  await fsp.writeFile(file, JSON.stringify([{ skill_id: 1, version_id: 2, chunk_id: 3, kind: 'other' }]));
  assert.throws(() => readSidecar(dir), /entry 0/);
});
