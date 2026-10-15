import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichExisting, backfillQueriesEs, parseBackfillArgs, parseAuditJsonl, importAudit } from '../../lib/backfill.mjs';
import { pack } from '../../lib/tar.mjs';
import { file, captureLog } from '../helpers.mjs';

const tgz = (body) => pack([file('SKILL.md', `---\nname: x\ndescription: y\n---\n${body}`)]);

function fakeRepo(targets, { current = () => true } = {}) {
  const calls = { list: [], add: [], tarball: [] };
  return {
    calls,
    async listEnrichmentTargets(opts) { calls.list.push(opts); return targets; },
    async getTarball(slug) { calls.tarball.push(slug); return { tarball: slug === 'broken' ? Buffer.from('nope') : tgz(`# ${slug} body`) }; },
    async addQueryChunks(arg) { calls.add.push(arg); return current(arg); },
  };
}

const target = (slug, extra = {}) => ({ skill_id: slug.length, version_id: 10 + slug.length, slug, name: slug, description: `${slug} desc`, kind: 'skill', plugin_slug: null, tags: [], ...extra });
const fakeEmbed = async (texts) => texts.map(() => [0.1, 0.2]);

test('enrichExisting reads the SKILL.md body from the tarball, embeds the queries and stores query chunks and merged tags', async () => {
  const repo = fakeRepo([target('audio', { tags: ['Legacy'] }), target('p@m:s', { skill_id: 7, plugin_slug: 'p@m' })]);
  const seen = [];
  const enrich = async (s) => { seen.push(s); return { queries_en: [`${s.name} q1`], queries_es: [`${s.name} q2`], queries: [`${s.name} q1`, `${s.name} q2`], tags: ['audio', 'mixing'] }; };
  const embedded = [];
  const out = await enrichExisting({ repo, enrich, embed: async (t) => { embedded.push(t); return fakeEmbed(t); }, log: captureLog() });
  assert.deepEqual(out.enriched.sort(), ['audio', 'p@m:s']);
  assert.deepEqual(repo.calls.tarball, ['audio'], 'plugin skills have no tarball');
  const bySlug = Object.fromEntries(seen.map((s) => [s.name, s]));
  assert.equal(bySlug.audio.body, '# audio body');
  assert.equal(bySlug.audio.description, 'audio desc');
  assert.equal(bySlug['p@m:s'].body, '');
  const add = repo.calls.add.find((a) => a.skillId === 5);
  assert.equal(add.versionId, 15);
  assert.deepEqual(add.chunks.map((c) => [c.text, c.kind]), [['audio q1', 'query'], ['audio q2', 'query']]);
  assert.deepEqual(add.chunks[0].embedding, [0.1, 0.2]);
  assert.deepEqual(add.tags, ['legacy', 'audio', 'mixing']);
  assert.deepEqual(add.queriesEs, ['audio q2'], 'the Spanish queries reach addQueryChunks, which writes queries_es_text with the chunks');
  assert.equal(embedded.length, 2);
});

test('dry-run enriches and logs but neither embeds nor writes', async () => {
  const repo = fakeRepo([target('audio')]);
  const log = captureLog();
  let embeds = 0;
  const out = await enrichExisting({
    repo, dryRun: true, log,
    enrich: async () => ({ queries_en: ['master my podcast'], queries_es: [], queries: ['master my podcast'], tags: ['audio'] }),
    embed: async (t) => { embeds++; return fakeEmbed(t); },
  });
  assert.equal(embeds, 0);
  assert.equal(repo.calls.add.length, 0);
  assert.deepEqual(out.enriched, ['audio']);
  assert.match(log.text(), /audio/);
  assert.match(log.text(), /master my podcast/);
});

test('limit, only and force reach the listing; limit caps the work', async () => {
  const repo = fakeRepo(['a', 'b', 'c'].map((s) => target(s)));
  const out = await enrichExisting({ repo, limit: 2, only: ['a', 'b', 'c'], force: true, enrich: async () => ({ queries_en: ['q'], queries_es: [], queries: ['q'], tags: [] }), embed: fakeEmbed, log: captureLog() });
  assert.deepEqual(repo.calls.list, [{ force: true, only: ['a', 'b', 'c'] }]);
  assert.equal(out.enriched.length, 2);
  assert.deepEqual(repo.calls.add.map((a) => a.skillId).sort(), [1, 1]);
});

test('a failed enrichment or unreadable tarball is reported and the run continues', async () => {
  const repo = fakeRepo([target('ok'), target('bad'), target('broken')]);
  const log = captureLog();
  const out = await enrichExisting({
    repo, log, embed: fakeEmbed,
    enrich: async (s) => { if (s.name === 'bad') throw new Error('gateway down'); return { queries_en: ['q'], queries_es: [], queries: ['q'], tags: [] }; },
  });
  assert.deepEqual(out.enriched.sort(), ['broken', 'ok']);
  assert.deepEqual(out.failed, [{ slug: 'bad', reason: 'gateway down' }]);
  assert.match(log.text(), /broken.*SKILL\.md/);
});

test('a skill whose version changed meanwhile is skipped, not failed', async () => {
  const repo = fakeRepo([target('moved')], { current: () => false });
  const out = await enrichExisting({ repo, enrich: async () => ({ queries_en: ['q'], queries_es: [], queries: ['q'], tags: [] }), embed: fakeEmbed, log: captureLog() });
  assert.deepEqual(out.skipped, ['moved']);
  assert.deepEqual(out.enriched, []);
});

test('runs at most 4 enrichments at a time', async () => {
  const repo = fakeRepo(Array.from({ length: 10 }, (_, i) => target(`s${i}`, { skill_id: i })));
  let inFlight = 0;
  let peak = 0;
  const enrich = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { queries_en: ['q'], queries_es: [], queries: ['q'], tags: [] };
  };
  const out = await enrichExisting({ repo, enrich, embed: fakeEmbed, log: captureLog() });
  assert.equal(out.enriched.length, 10);
  assert.equal(peak, 4);
});

test('parseBackfillArgs reads --dry-run, --limit, --only and --force', () => {
  assert.deepEqual(parseBackfillArgs([]), { dryRun: false, limit: undefined, only: [], force: false });
  assert.deepEqual(parseBackfillArgs(['--dry-run', '--limit', '3', '--only', 'a, b,', '--force']), { dryRun: true, limit: 3, only: ['a', 'b'], force: true });
  assert.throws(() => parseBackfillArgs(['--limit', '0']), /--limit/);
  assert.throws(() => parseBackfillArgs(['--limit', 'x']), /--limit/);
  assert.throws(() => parseBackfillArgs(['--nope']), /nope/);
});

// --- Spanish query text backfill ---

// rows: current versions as listQueriesEsTargets returns them, plus `text` (the stored queries_es_text).
function fakeEsRepo(rows, { update = () => true } = {}) {
  const calls = { list: [], set: [], tarball: [] };
  const state = rows.map((r) => ({ text: '', ...r }));
  return {
    calls,
    state,
    async listQueriesEsTargets(opts) {
      calls.list.push(opts);
      return state
        .filter((r) => (opts.force || r.text === '') && (!opts.only?.length || opts.only.includes(r.slug)))
        .map(({ text, ...r }) => ({ ...r, has_text: text !== '' }));
    },
    async getTarball(slug) { calls.tarball.push(slug); return { tarball: tgz(`# ${slug} body`) }; },
    async setQueriesEs(skillId, versionId, text) {
      calls.set.push({ skillId, versionId, text });
      if (!update(skillId)) return false;
      state.find((r) => r.skill_id === skillId).text = text;
      return true;
    },
  };
}

const GENERATED_QUERY = 'limpiar el ruido de la grabación';
const fakeEnrichEs = ({ fail = [], usage = { inputTokens: 100, outputTokens: 20 } } = {}) => {
  const seen = [];
  const fn = async (s) => {
    seen.push(s);
    if (fail.includes(s.name)) throw new Error('gateway down');
    return { queries_es: [`${s.name} uno`, GENERATED_QUERY], usage };
  };
  fn.seen = seen;
  return fn;
};

test('backfillQueriesEs writes the Spanish queries joined by a space, reads the SKILL.md body and reports counts and summed usage', async () => {
  const repo = fakeEsRepo([target('audio'), target('p@m:s', { skill_id: 7, plugin_slug: 'p@m' }), target('done', { text: 'ya estaba' })]);
  const enrichEs = fakeEnrichEs();
  const out = await backfillQueriesEs({ repo, enrichEs, log: captureLog() });
  assert.deepEqual(out.before, { total: 3, withText: 1 });
  assert.deepEqual(out.after, { total: 3, withText: 3 });
  assert.deepEqual(out.filled.sort(), ['audio', 'p@m:s']);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 40 });
  assert.deepEqual(repo.calls.set.find((c) => c.skillId === 5), { skillId: 5, versionId: 15, text: `audio uno ${GENERATED_QUERY}` }, 'the write is guarded by the listed version');
  assert.deepEqual(repo.calls.tarball, ['audio'], 'plugin skills have no tarball');
  const bySlug = Object.fromEntries(enrichEs.seen.map((s) => [s.name, s]));
  assert.deepEqual(bySlug.audio, { name: 'audio', description: 'audio desc', body: '# audio body' });
  assert.equal(bySlug['p@m:s'].body, '');
  assert.equal(repo.state.find((r) => r.slug === 'done').text, 'ya estaba', 'non-empty text is not touched');
});

test('backfillQueriesEs skips skills with text unless force; a second run fills nothing', async () => {
  const repo = fakeEsRepo([target('a'), target('bb', { text: 'viejo' })]);
  const first = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs(), log: captureLog() });
  assert.deepEqual(first.filled, ['a']);
  const second = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs(), log: captureLog() });
  assert.deepEqual(second.filled, []);
  assert.deepEqual(second.usage, { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(second.before, { total: 2, withText: 2 });
  assert.deepEqual(second.after, { total: 2, withText: 2 });
  assert.equal(repo.calls.set.length, 1);
  const forced = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs(), log: captureLog(), force: true });
  assert.deepEqual(forced.filled.sort(), ['a', 'bb']);
  assert.equal(repo.state.find((r) => r.slug === 'bb').text, `bb uno ${GENERATED_QUERY}`);
});

test('backfillQueriesEs --dry-run generates and sums usage but writes nothing; after equals before', async () => {
  const repo = fakeEsRepo([target('a'), target('bb')]);
  const out = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs(), log: captureLog(), dryRun: true });
  assert.equal(repo.calls.set.length, 0);
  assert.deepEqual(out.before, { total: 2, withText: 0 });
  assert.deepEqual(out.after, out.before);
  assert.deepEqual(out.filled.sort(), ['a', 'bb']);
  assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 40 });
});

test('backfillQueriesEs: a failing skill lands in failed with its reason and the rest continue', async () => {
  const repo = fakeEsRepo([target('ok'), target('bad'), target('fine')]);
  const out = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs({ fail: ['bad'] }), log: captureLog() });
  assert.deepEqual(out.filled.sort(), ['fine', 'ok']);
  assert.deepEqual(out.failed, [{ slug: 'bad', reason: 'gateway down' }]);
  assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 40 }, 'only the skills that returned count');
  assert.deepEqual(out.after, { total: 3, withText: 2 });
});

test('backfillQueriesEs sums usage with missing counts as 0 and reports a write that matched no row as skipped', async () => {
  const repo = fakeEsRepo([target('gone', { skill_id: 1 }), target('here', { skill_id: 2 })], { update: (id) => id !== 1 });
  const enrichEs = async (s) => ({ queries_es: ['uno', 'dos'], usage: s.name === 'gone' ? { inputTokens: 5 } : undefined });
  const out = await backfillQueriesEs({ repo, enrichEs, log: captureLog() });
  assert.deepEqual(out.skipped, ['gone']);
  assert.deepEqual(out.filled, ['here']);
  assert.deepEqual(out.usage, { inputTokens: 5, outputTokens: 0 });
});

test('backfillQueriesEs passes force and only to the listing, counts over every current version, and caps the work with limit', async () => {
  const repo = fakeEsRepo(['a', 'b', 'c', 'd'].map((s, i) => target(s, { skill_id: i + 1 })));
  const out = await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs(), log: captureLog(), limit: 2, only: ['a', 'b', 'c'], force: true });
  assert.ok(repo.calls.list.some((o) => o.force === true && JSON.stringify(o.only) === '["a","b","c"]'), 'targets listed with force and only');
  assert.equal(out.filled.length, 2);
  assert.deepEqual(out.before, { total: 4, withText: 0 }, 'counts cover all current versions, not only the targets');
  assert.deepEqual(out.after, { total: 4, withText: 2 });
});

test('backfillQueriesEs runs at most 4 generations at a time', async () => {
  const repo = fakeEsRepo(Array.from({ length: 10 }, (_, i) => target(`s${i}`, { skill_id: i })));
  let inFlight = 0;
  let peak = 0;
  const enrichEs = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { queries_es: ['uno', 'dos'], usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const out = await backfillQueriesEs({ repo, enrichEs, log: captureLog() });
  assert.equal(out.filled.length, 10);
  assert.equal(peak, 4);
});

test('backfillQueriesEs never logs the generated query text in a real run', async () => {
  const repo = fakeEsRepo([target('audio')]);
  const log = captureLog();
  await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs(), log });
  assert.match(log.text(), /audio/);
  assert.doesNotMatch(log.text(), /limpiar el ruido|audio uno/);
});

test('backfillQueriesEs --dry-run logs each slug with its generated Spanish queries, as a quality sample', async () => {
  const repo = fakeEsRepo([target('audio'), target('mix')]);
  const log = captureLog();
  await backfillQueriesEs({ repo, enrichEs: fakeEnrichEs(), log, dryRun: true });
  for (const slug of ['audio', 'mix']) {
    const entry = log.lines.find((l) => l.startsWith(`dry   ${slug} `));
    assert.ok(entry, slug);
    assert.match(entry, new RegExp(`\\n    · ${slug} uno\\n    · ${GENERATED_QUERY}$`));
  }
});

// --- Audit metadata import ---

test('parseAuditJsonl reads one JSON object per line and reports bad lines', () => {
  const { rows, errors } = parseAuditJsonl('{"name":"a"}\n\n  \nnot json\n{"name":"b"}\n');
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line 4/);
});

test('importAudit sets quality and tags for VAULT and VAULT_AFTER_FIX rows that exist, by folder name', async () => {
  const calls = [];
  const repo = { async setAuditMetadata(slug, quality, tags) { calls.push({ slug, quality, tags }); return slug !== 'not-in-vault'; } };
  const rows = [
    { path: 'Claude/x/.claude/skills/text-to-speech', name: 'text-to-speech', reuse: 3, trigger: 3, content: 2, health: 2, verdict: 'VAULT', why: 'w', fixes: [], suggested_tags: ['tts', 'audio'] },
    { path: 'P/.claude/skills/shadcn-ui-blocks', name: 'Shadcn UI & Blocks', reuse: 2, trigger: 3, content: 3, health: 1, verdict: 'VAULT_AFTER_FIX', suggested_tags: ['shadcn'] },
    { path: 'P/.claude/skills/agora', name: 'agora', reuse: 0, trigger: 2, content: 2, health: 2, verdict: 'PROJECT_LOCAL', suggested_tags: ['x'] },
    { path: 'P/.claude/skills/modal', name: 'modal', verdict: 'DISCARD' },
    { path: 'P/.claude/skills/not-in-vault', name: 'n', reuse: 1, trigger: 1, content: 1, health: 1, verdict: 'VAULT', suggested_tags: [] },
  ];
  const log = captureLog();
  const out = await importAudit({ repo, rows, log, now: () => '2026-09-23T12:00:00.000Z' });
  assert.deepEqual(calls.map((c) => c.slug), ['text-to-speech', 'shadcn-ui-blocks', 'not-in-vault']);
  assert.deepEqual(calls[0].quality, { reuse: 3, trigger: 3, content: 2, health: 2, verdict: 'VAULT', audited_at: '2026-09-23T12:00:00.000Z' });
  assert.deepEqual(calls[0].tags, ['tts', 'audio']);
  assert.deepEqual(out, { updated: ['text-to-speech', 'shadcn-ui-blocks'], missing: ['not-in-vault'], ignored: 2, invalid: [] });
  assert.match(log.text(), /not-in-vault/);
});

test('importAudit rejects rows with a bad slug or non-numeric scores', async () => {
  const calls = [];
  const repo = { async setAuditMetadata(slug) { calls.push(slug); return true; } };
  const rows = [
    { path: 'a/b/bad slug', reuse: 1, trigger: 1, content: 1, health: 1, verdict: 'VAULT' },
    { path: 'a/b/ok', reuse: '3', trigger: 1, content: 1, health: 1, verdict: 'VAULT' },
    { path: 'a/b/ok2', reuse: 4, trigger: 1, content: 1, health: 1, verdict: 'VAULT' },
    { verdict: 'VAULT' },
  ];
  const out = await importAudit({ repo, rows, log: captureLog(), now: () => 't' });
  assert.deepEqual(calls, []);
  assert.equal(out.invalid.length, 4);
});
