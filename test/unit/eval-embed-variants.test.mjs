import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localTest } from '../local-helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { loadVec } from '../../lib/local/vec.mjs';
import { readSidecar, buildAllowLists } from '../../lib/suggest-eval-chunks.mjs';
import { chunkSkill, readSkillInfo } from '../../lib/skillmd.mjs';
import { pack, unpack } from '../../lib/tar.mjs';

// Every test uses temporary directories and a temporary HEADJACK_HOME; none touches the real ~/.headjack.
const temp = () => mkdtemp(path.join(os.tmpdir(), 'headjack-eval-embed-'));

// A vault in <dir>/vault.db with two skills (three chunks of their current versions), and an eval file at
// <dir>/suggest/eval.json.
async function sourceVault(dir) {
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    const repo = createSqliteRepo(db);
    for (const [slug, chunks] of [['alpha', ['alpha one', 'alpha two']], ['beta', ['beta one']]]) {
      const ids = await repo.publish({
        manifest: { slug, name: slug, description: 'description', kind: 'plugin', tags: [], source: { kind: 'local' }, sha256: slug.padEnd(64, '0'), status: 'approved' },
        tarball: null,
        chunks: chunks.map((text) => ({ text })),
      });
      await repo.replaceChunks({ skillId: ids.skillId, versionId: ids.versionId, contentChunks: chunks });
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  await mkdir(path.join(dir, 'suggest'), { recursive: true });
  await writeFile(path.join(dir, 'suggest', 'eval.json'), '[{"q":"from beside"}]');
}

async function harness() {
  const home = await temp();
  const from = await temp();
  const to = path.join(await temp(), 'copy');
  await sourceVault(from);
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); throw new Error('network must not be used'); };
  const logs = [];
  const base = { from: path.join(from, 'vault.db'), to, env: { HEADJACK_HOME: home }, fetchImpl, log: (s) => logs.push(s) };
  return { home, from, to, calls, logs, base };
}

async function run(options) {
  const { run: runScript } = await import('../../scripts/eval-embed-variants.mjs');
  return runScript(options);
}

localTest('refuses a --to inside the default state directory', async () => {
  const h = await harness();
  const inside = path.join(h.home, 'nested', 'copy');
  await assert.rejects(run({ ...h.base, to: inside }), (e) => e.exitCode === 2 && /state directory/.test(e.message));
  await assert.rejects(run({ ...h.base, to: h.home }), (e) => e.exitCode === 2);
  // a symlink into the state directory resolves to it
  const link = path.join(await temp(), 'link');
  await symlink(h.home, link);
  await assert.rejects(run({ ...h.base, to: path.join(link, 'copy') }), (e) => e.exitCode === 2);
  await assert.rejects(stat(path.join(h.home, 'nested')), { code: 'ENOENT' });
  assert.equal(h.calls.length, 0);
});

localTest('refuses a --to named with a leading ".." inside the default state directory', async () => {
  const h = await harness();
  const inside = path.join(h.home, '..copy');
  await assert.rejects(run({ ...h.base, to: inside }), (e) => e.exitCode === 2 && /state directory/.test(e.message));
  await assert.rejects(stat(inside), { code: 'ENOENT' });
  assert.equal(h.calls.length, 0);
});

localTest('refuses a --to that names the default state directory with different letter case', async (t) => {
  const h = await harness();
  const swapped = path.basename(h.home).replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const variant = path.join(path.dirname(h.home), swapped);
  // only a case-insensitive filesystem resolves the variant to the real directory
  if (!existsSync(variant)) return t.skip('the temp filesystem is case-sensitive');
  await assert.rejects(run({ ...h.base, to: path.join(variant, 'copy') }), (e) => e.exitCode === 2 && /state directory/.test(e.message));
  await assert.rejects(stat(path.join(h.home, 'copy')), { code: 'ENOENT' });
  assert.equal(h.calls.length, 0);
});

localTest('accepts a --from inside the default state directory and only reads it', async () => {
  const home = await temp();
  await sourceVault(home);
  const file = path.join(home, 'vault.db');
  const before = await readFile(file);
  const to = path.join(await temp(), 'copy');
  const result = await run({ from: file, to, env: { HEADJACK_HOME: home }, fetchImpl: async () => { throw new Error('no network'); }, log: () => {} });
  assert.equal(result.copied, true);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(path.join(to, 'suggest', 'eval.json'), 'utf8'), '[{"q":"from beside"}]');
});

localTest('takes the eval file from --eval, else from beside --from', async () => {
  const h = await harness();
  const other = path.join(await temp(), 'other-eval.json');
  await writeFile(other, '[{"q":"explicit"}]');
  await run({ ...h.base, evalFile: other });
  assert.equal(await readFile(path.join(h.to, 'suggest', 'eval.json'), 'utf8'), '[{"q":"explicit"}]');

  const second = path.join(await temp(), 'copy');
  await run({ ...h.base, to: second });
  assert.equal(await readFile(path.join(second, 'suggest', 'eval.json'), 'utf8'), '[{"q":"from beside"}]');
});

localTest('refuses an existing target vault', async () => {
  const h = await harness();
  await mkdir(h.to, { recursive: true });
  await writeFile(path.join(h.to, 'vault.db'), 'keep me');
  await assert.rejects(run(h.base), (e) => e.exitCode === 2 && /already exists/.test(e.message));
  assert.equal(await readFile(path.join(h.to, 'vault.db'), 'utf8'), 'keep me');
  await assert.rejects(stat(path.join(h.to, 'suggest')), { code: 'ENOENT' });
});

localTest('copies the vault and the eval file', async () => {
  const h = await harness();
  const result = await run(h.base);
  assert.equal(result.copied, true);
  const { DatabaseSync } = await runtimeCheck();
  const db = new DatabaseSync(path.join(h.to, 'vault.db'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('select slug from skills order by slug').all().map((r) => r.slug), ['alpha', 'beta']);
    assert.equal(db.prepare('select count(*) as n from chunks').get().n, 3);
  } finally {
    db.close();
  }
  assert.equal(await readFile(path.join(h.to, 'suggest', 'eval.json'), 'utf8'), '[{"q":"from beside"}]');
});

localTest('without --yes sends nothing and prints a text count', async () => {
  const h = await harness();
  const result = await run(h.base);
  assert.equal(result.texts, 3);
  assert.equal(h.calls.length, 0);
  assert.ok(h.logs.some((line) => /3 texts/.test(line)), h.logs.join('\n'));
});

// ---- --yes: embedding on the copy and the sidecar. Every call goes to a fake fetchImpl; no network, no key, no
// ~/.headjack.
const KEY = 'test-gateway-key';
const SPANISH = Array.from({ length: 8 }, (_, i) => `Necesito revisar el proyecto numero ${i}`);
const SECRET = `github_pat_${'a'.repeat(82)}`;

// Records every request, answers the chat (Spanish enrichment) and embeddings endpoints with fixed 1536-dimension data.
function gateway(calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith('/chat/completions')) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ queries_es: SPANISH }) } }] });
    }
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: Array.from({ length: 1536 }, (__, i) => (i === 0 ? 1 : 0)) })) });
  };
}

const SKILL_MD = '---\nname: beta\ndescription: beta skill from its archive\n---\n# Beta\n\nBeta body paragraph.\n';
const betaArchive = () => pack([{ path: 'SKILL.md', mode: 0o644, data: Buffer.from(SKILL_MD) }]);

// alpha: plugin skill, stored tags that do not name its plugin, archive-less (no name: description chunk);
// beta: archive with a root SKILL.md, whose chunk 0 is already name: description;
// gamma: no tags; delta: plugin skill whose stored tags already name the plugin; epsilon: plugin skill with no stored tags.
async function richVault(dir, extra = []) {
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync, allowExtension: true });
  try {
    const repo = createSqliteRepo(db);
    const tarball = betaArchive();
    const betaChunks = chunkSkill(readSkillInfo(unpack(tarball), 'beta'));
    const specs = [
      { slug: 'alpha', description: 'alpha description', kind: 'plugin', plugin_slug: 'My_Plugin@market', tags: ['review'], chunks: ['alpha one'] },
      { slug: 'beta', description: 'beta skill from its archive', kind: 'skill', tags: ['x', 'y'], tarball, chunks: betaChunks },
      { slug: 'gamma', description: 'gamma description', kind: 'skill', tags: [], chunks: ['gamma one'] },
      { slug: 'delta', description: 'delta description', kind: 'plugin', plugin_slug: 'toolkit@market', tags: ['toolkit', 'other'], chunks: ['delta one'] },
      { slug: 'epsilon', description: 'epsilon description', kind: 'plugin', plugin_slug: 'solo@market', tags: [], chunks: ['epsilon one'] },
      ...extra,
    ];
    for (const spec of specs) {
      const ids = await repo.publish({
        manifest: {
          slug: spec.slug, name: spec.slug, description: spec.description, kind: spec.kind, plugin_slug: spec.plugin_slug ?? null,
          tags: spec.tags, source: { kind: 'local' }, sha256: spec.slug.padEnd(64, '0'), status: 'approved',
        },
        tarball: spec.tarball ?? null,
        chunks: spec.chunks.map((text) => ({ text })),
      });
      await repo.replaceChunks({ skillId: ids.skillId, versionId: ids.versionId, contentChunks: spec.chunks });
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  await mkdir(path.join(dir, 'suggest'), { recursive: true });
  await writeFile(path.join(dir, 'suggest', 'eval.json'), '[{"q":"from beside"}]');
}

async function yesHarness(extra = []) {
  const home = await temp();
  const from = await temp();
  const to = path.join(await temp(), 'copy');
  await richVault(from, extra);
  const calls = [];
  const logs = [];
  const base = {
    from: path.join(from, 'vault.db'), to, yes: true, env: { HEADJACK_HOME: home, AI_GATEWAY_API_KEY: KEY },
    fetchImpl: gateway(calls), log: (s) => logs.push(s),
  };
  return { home, from, to, calls, logs, base };
}

async function openCopy(to) {
  const { DatabaseSync } = await runtimeCheck();
  const db = new DatabaseSync(path.join(to, 'vault.db'), { allowExtension: true });
  assert.equal(loadVec(db), true);
  return db;
}

const slugOf = (db, skillId) => db.prepare('select slug from skills where id = ?').get(skillId).slug;
const chunkOf = (db, id) => db.prepare('select skill_id, version_id, text, kind from chunks where id = ?').get(id);
const embeddedIds = (db) => new Set(db.prepare('select rowid from chunk_vecs').all().map((r) => Number(r.rowid)));

localTest('--yes embeds the copy and writes the sidecar', async () => {
  const h = await yesHarness();
  const result = await run(h.base);
  assert.equal(result.copied, true);
  const sidecar = readSidecar(h.to);
  assert.ok(Array.isArray(sidecar) && sidecar.length > 0);
  const db = await openCopy(h.to);
  try {
    // every chunk of the copy has a vector, and all three allow-list pairs are usable
    const embedded = embeddedIds(db);
    const ids = db.prepare('select id from chunks').all().map((r) => r.id);
    assert.ok(ids.every((id) => embedded.has(id)), 'a chunk has no vector');
    const lists = buildAllowLists({ db, sidecar, vecLoaded: true });
    assert.deepEqual(lists.invalid, {});
    assert.equal(lists.skillsWithoutFrontmatter, 0);
    for (const pair of ['hybrid', 'hybrid-meta', 'hybrid-meta-tags']) assert.ok(lists.lists[pair].size > 0, pair);
    // an entry is {skill_id, version_id, chunk_id, kind} and nothing else
    for (const entry of sidecar) assert.deepEqual(Object.keys(entry).sort(), ['chunk_id', 'kind', 'skill_id', 'version_id']);
  } finally {
    db.close();
  }
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every((call) => call.url.startsWith('https://ai-gateway.vercel.sh/')));
});

localTest('frontmatter entries exist only for skills lacking a name: description chunk', async () => {
  const h = await yesHarness();
  await run(h.base);
  const db = await openCopy(h.to);
  try {
    const entries = readSidecar(h.to).filter((e) => e.kind === 'frontmatter');
    // beta's archive already yields the chunk; the archive-less plugin and skill rows do not
    assert.deepEqual(entries.map((e) => slugOf(db, e.skill_id)).sort(), ['alpha', 'delta', 'epsilon', 'gamma']);
    for (const entry of entries) {
      const row = chunkOf(db, entry.chunk_id);
      const skill = db.prepare('select slug, name, description, current_version_id from skills where id = ?').get(entry.skill_id);
      assert.equal(row.kind, 'content');
      assert.equal(row.text, `${skill.name}: ${skill.description}`);
      assert.equal(entry.version_id, skill.current_version_id);
      assert.equal(row.version_id, skill.current_version_id);
      assert.ok(embeddedIds(db).has(entry.chunk_id), `${skill.slug} frontmatter has no vector`);
    }
    // beta kept exactly its archive chunks
    const beta = db.prepare("select id from skills where slug = 'beta'").get().id;
    assert.deepEqual(
      db.prepare("select text from chunks where skill_id = ? and kind = 'content' order by id").all(beta).map((r) => r.text),
      chunkSkill(readSkillInfo(unpack(betaArchive()), 'beta')),
    );
  } finally {
    db.close();
  }
});

localTest('tag rows are query chunks with vectors and kind tags', async () => {
  const h = await yesHarness();
  await run(h.base);
  const db = await openCopy(h.to);
  try {
    const entries = readSidecar(h.to).filter((e) => e.kind === 'tags');
    // every skill has a tag row, including gamma, which has no tags and no plugin
    assert.deepEqual(entries.map((e) => slugOf(db, e.skill_id)).sort(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
    const texts = {};
    for (const entry of entries) {
      const row = chunkOf(db, entry.chunk_id);
      assert.equal(row.kind, 'query');
      assert.equal(row.version_id, entry.version_id);
      assert.ok(embeddedIds(db).has(entry.chunk_id));
      texts[slugOf(db, entry.skill_id)] = row.text;
    }
    assert.equal(texts.beta, 'beta: beta skill from its archive | tags: x, y');
    assert.equal(texts.delta, 'delta: delta description | tags: toolkit, other');
    // an untagged, non-plugin skill: name: description with no tags suffix
    assert.equal(texts.gamma, 'gamma: gamma description');
    // the Spanish query chunks of the backfill survive: nothing re-ran the backfill after the tag rows
    const ids = new Set(entries.map((e) => e.chunk_id));
    const spanish = db.prepare("select id, skill_id from chunks where kind = 'query'").all().filter((r) => !ids.has(r.id));
    assert.equal(new Set(spanish.map((r) => r.skill_id)).size, 5);
  } finally {
    db.close();
  }
});

localTest('an untagged, non-plugin skill gets a tag row, so hybrid-meta-tags can return it', async () => {
  const h = await yesHarness();
  await run(h.base);
  const db = await openCopy(h.to);
  try {
    const sidecar = readSidecar(h.to);
    const gamma = db.prepare("select id from skills where slug = 'gamma'").get().id;
    const entry = sidecar.find((e) => e.skill_id === gamma && e.kind === 'tags');
    assert.ok(entry, 'gamma has no tag row');
    const row = chunkOf(db, entry.chunk_id);
    assert.equal(row.kind, 'query');
    assert.equal(row.text, 'gamma: gamma description');
    assert.ok(!row.text.includes('tags:'));
    assert.ok(embeddedIds(db).has(entry.chunk_id));
    // the reader's hybrid-meta-tags allow-list holds a row for every skill
    const lists = buildAllowLists({ db, sidecar, vecLoaded: true });
    assert.equal(lists.lists['hybrid-meta-tags'].has(entry.chunk_id), true);
    const tagSkills = new Set(sidecar.filter((e) => e.kind === 'tags').map((e) => e.skill_id));
    const all = db.prepare('select id from skills where current_version_id is not null').all().map((r) => r.id);
    assert.ok(all.every((id) => tagSkills.has(id)), 'a skill has no tag row');
  } finally {
    db.close();
  }
});

localTest('a long description is cut before the tag suffix, so the tags survive within 1000 characters', async () => {
  const long = 'x'.repeat(1500);
  const h = await yesHarness([{ slug: 'wordy', description: long, kind: 'skill', tags: ['alpha-tag', 'beta-tag'], chunks: ['wordy one'] }]);
  await run(h.base);
  const db = await openCopy(h.to);
  try {
    const wordy = db.prepare("select id from skills where slug = 'wordy'").get().id;
    const entry = readSidecar(h.to).find((e) => e.skill_id === wordy && e.kind === 'tags');
    const text = chunkOf(db, entry.chunk_id).text;
    assert.ok(text.length <= 1000, `length ${text.length}`);
    assert.ok(text.endsWith(' | tags: alpha-tag, beta-tag'), text.slice(-60));
    assert.ok(text.startsWith('wordy: xxx'));
    // the frontmatter row keeps the plain cut at 1000
    const front = readSidecar(h.to).find((e) => e.skill_id === wordy && e.kind === 'frontmatter');
    assert.equal(chunkOf(db, front.chunk_id).text.length, 1000);
  } finally {
    db.close();
  }
});

localTest('a long untagged description is cut at 1000 characters', async () => {
  const h = await yesHarness([{ slug: 'wordy', description: 'y'.repeat(1500), kind: 'skill', tags: [], chunks: ['wordy one'] }]);
  await run(h.base);
  const db = await openCopy(h.to);
  try {
    const wordy = db.prepare("select id from skills where slug = 'wordy'").get().id;
    const entry = readSidecar(h.to).find((e) => e.skill_id === wordy && e.kind === 'tags');
    assert.equal(chunkOf(db, entry.chunk_id).text.length, 1000);
  } finally {
    db.close();
  }
});

localTest('a plugin skill tag text includes its derived plugin tag even when its stored tags do not name the plugin, and the skills row is unchanged', async () => {
  const h = await yesHarness();
  await run(h.base);
  const db = await openCopy(h.to);
  try {
    const texts = Object.fromEntries(readSidecar(h.to).filter((e) => e.kind === 'tags')
      .map((e) => [slugOf(db, e.skill_id), chunkOf(db, e.chunk_id).text]));
    // plugin_slug "My_Plugin@market": the part before @, normalized
    assert.equal(texts.alpha, 'alpha: alpha description | tags: review, my-plugin');
    // already named: not repeated
    assert.equal(texts.delta, 'delta: delta description | tags: toolkit, other');
    // no stored tags: the plugin tag alone
    assert.equal(texts.epsilon, 'epsilon: epsilon description | tags: solo');
    // the copy's skills rows carry the stored tags only, same as the source
    const source = await runtimeCheck().then(({ DatabaseSync }) => new DatabaseSync(path.join(h.from, 'vault.db'), { readOnly: true }));
    try {
      const rows = (database) => database.prepare('select slug, tags, plugin_slug from skills order by slug').all().map((r) => ({ ...r }));
      assert.deepEqual(rows(db), rows(source));
    } finally {
      source.close();
    }
  } finally {
    db.close();
  }
});

localTest('a skill whose text trips the secret scan is skipped and reported', async () => {
  const h = await yesHarness([{ slug: 'leaky', description: `uses ${SECRET} to log in`, kind: 'skill', tags: ['auth'], chunks: ['leaky one'] }]);
  const result = await run(h.base);
  const rules = result.skipped.filter((s) => s.slug === 'leaky');
  assert.deepEqual(rules.map((s) => s.kind).sort(), ['frontmatter', 'tags']);
  assert.ok(rules.every((s) => s.rule === 'github-token'), JSON.stringify(rules));
  // the text is neither sent nor logged nor stored as a chunk
  for (const call of h.calls) assert.ok(!JSON.stringify(call.body).includes('github_pat_'));
  assert.ok(!h.logs.join('\n').includes('github_pat_'));
  assert.ok(h.logs.some((line) => /leaky/.test(line) && /github-token/.test(line)), h.logs.join('\n'));
  const db = await openCopy(h.to);
  try {
    const leaky = db.prepare("select id from skills where slug = 'leaky'").get().id;
    assert.ok(readSidecar(h.to).every((e) => e.skill_id !== leaky));
    assert.equal(db.prepare("select count(*) as n from chunks where skill_id = ? and text like '%github_pat_%'").get(leaky).n, 0);
    // the other skills are unaffected
    assert.equal(readSidecar(h.to).filter((e) => e.kind === 'tags').length, 5);
  } finally {
    db.close();
  }
});

localTest('the backfill runs once, before the tag rows exist', async () => {
  const h = await yesHarness();
  await run(h.base);
  const tagCall = (call) => call.body.input?.some((text) => text.includes(' | tags: '));
  const tagIndexes = h.calls.flatMap((call, i) => (tagCall(call) ? [i] : []));
  const otherIndexes = h.calls.flatMap((call, i) => (tagCall(call) ? [] : [i]));
  assert.ok(tagIndexes.length > 0);
  assert.ok(Math.max(...otherIndexes) < Math.min(...tagIndexes), 'a backfill request came after a tag request');
  // one Spanish enrichment per skill and one embedding of each stored chunk text: a second backfill would repeat them
  assert.equal(h.calls.filter((call) => call.url.endsWith('/chat/completions')).length, 5);
  const sentOnce = (text) => h.calls.filter((call) => call.body.input?.includes(text)).length;
  assert.equal(sentOnce('alpha one'), 1);
  assert.equal(sentOnce('gamma one'), 1);
});

localTest('the source vault file is byte-identical before and after', async () => {
  const h = await yesHarness();
  const file = path.join(h.from, 'vault.db');
  const before = await readFile(file);
  await run(h.base);
  assert.deepEqual(await readFile(file), before);
  assert.equal(existsSync(`${file}-wal`) ? (await stat(`${file}-wal`)).size : 0, 0);
});

localTest('--yes without a key refuses before copying and sends nothing', async () => {
  const h = await yesHarness();
  await assert.rejects(run({ ...h.base, env: { HEADJACK_HOME: h.home } }), (e) => e.exitCode === 2 && /AI Gateway key/.test(e.message));
  await assert.rejects(stat(path.join(h.to, 'vault.db')), { code: 'ENOENT' });
  assert.equal(h.calls.length, 0);
});

localTest('the dry run also counts the frontmatter and tag texts a --yes run would add', async () => {
  const h = await yesHarness();
  const result = await run({ ...h.base, yes: false });
  assert.equal(h.calls.length, 0);
  assert.equal(result.frontmatterTexts, 4);
  assert.equal(result.tagTexts, 5);
  assert.ok(h.logs.some((line) => /4 frontmatter/.test(line) && /5 tag/.test(line)), h.logs.join('\n'));
});
