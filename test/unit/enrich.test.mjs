import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
import { enrichSkill, enrichSpanish, buildPrompt, gatewayGenerate, gatewayGenerateWithUsage, enrichModel, ENRICH_SCHEMA, ENRICH_ES_SCHEMA, MAX_BODY_CHARS } from '../../lib/enrich.mjs';
import { embedModel } from '../../lib/embed.mjs';
import { normalizeTag, mergeTags, tagsText, TAG_RE, MAX_TAGS } from '../../lib/tags.mjs';
import { limitEnrichment } from '../../lib/enrichment-limits.mjs';

const skill = { name: 'auphonic-mastering', description: 'Master podcast audio with the Auphonic CLI', body: '# Use\nRun auphonic.' };

const good = {
  queries_en: ['master my podcast audio', 'normalize loudness to -16 LUFS', 'clean up a noisy voice recording', 'upload an episode to auphonic'],
  queries_es: ['masterizar el audio de mi podcast', 'nivelar el volumen de una grabación'],
  tags: ['Audio', 'podcast mastering', 'auphonic'],
};

const fakeGenerate = (out) => {
  const calls = [];
  const fn = async (arg) => { calls.push(arg); return typeof out === 'function' ? out(arg) : out; };
  fn.calls = calls;
  return fn;
};

test('enrichSkill returns each language apart, their concatenation (English first) and kebab-case tags', async () => {
  const generate = fakeGenerate(good);
  const out = await enrichSkill(skill, { generate });
  assert.deepEqual(out.queries_en, good.queries_en);
  assert.deepEqual(out.queries_es, good.queries_es);
  assert.deepEqual(out.queries, [...good.queries_en, ...good.queries_es]);
  assert.deepEqual(out.tags, ['audio', 'podcast-mastering', 'auphonic']);
  assert.equal(generate.calls.length, 1);
});

test('enrichSkill trims, drops empties, dedupes case-insensitively and caps each language', async () => {
  const out = await enrichSkill(skill, {
    generate: fakeGenerate({
      queries_en: ['  a b  ', 'A B', '', '   ', 'c d', 'e f', 'g h', 'i j', 'k l'],
      queries_es: ['uno', 'UNO ', 'dos', 'tres', 'cuatro', 'a b'],
      tags: ['x', 'X', ' y ', '', 'z', 'w', 'v', 'u', 't'],
    }),
  });
  assert.deepEqual(out.queries, ['a b', 'c d', 'e f', 'g h', 'i j', 'uno', 'dos', 'tres']);
  assert.deepEqual(out.queries_es, ['uno', 'dos', 'tres']);
  assert.deepEqual(out.tags, ['x', 'y', 'z', 'w', 'v', 'u']);
});

test('limitEnrichment keeps queries_en and queries_es apart, caps them at 5 and 3, and concatenates them into queries', () => {
  const out = limitEnrichment({
    queries_en: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
    queries_es: ['s1', 's2', 's3', 's4'],
    tags: ['A'],
  });
  assert.deepEqual(out.queries_en, ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(out.queries_es, ['s1', 's2', 's3']);
  assert.deepEqual(out.queries, [...out.queries_en, ...out.queries_es]);
  assert.ok(out.queries.length <= 8);
  assert.deepEqual(out.tags, ['a']);
});

test('enrichSkill keeps every query within 140 chars, cutting at a word boundary', async () => {
  const long = `${'word '.repeat(40)}end`;
  const out = await enrichSkill(skill, { generate: fakeGenerate({ ...good, queries_en: [long, ...good.queries_en.slice(1)] }) });
  assert.ok(out.queries.every((q) => q.length <= 140));
  assert.ok(out.queries[0].startsWith('word word'));
  assert.ok(!out.queries[0].endsWith(' '));
  assert.match(out.queries[0], /word$/);
});

test('enrichSkill throws when the model returns too few items after cleanup', async () => {
  await assert.rejects(enrichSkill(skill, { generate: fakeGenerate({ ...good, queries_en: ['one', 'ONE', 'two', 'three'] }) }), /English/);
  await assert.rejects(enrichSkill(skill, { generate: fakeGenerate({ ...good, queries_es: ['uno', ''] }) }), /Spanish/);
  await assert.rejects(enrichSkill(skill, { generate: fakeGenerate({ ...good, tags: ['a', 'A', '!!!'] }) }), /tags/);
  await assert.rejects(enrichSkill(skill, { generate: fakeGenerate(null) }), /enrichment/);
  await assert.rejects(enrichSkill(skill, { generate: fakeGenerate({ queries_en: 'x', queries_es: [], tags: [] }) }), /enrichment/);
});

test('enrichSkill ignores non-string items', async () => {
  const out = await enrichSkill(skill, { generate: fakeGenerate({ ...good, queries_en: [1, null, ...good.queries_en], tags: [{}, ...good.tags] }) });
  assert.equal(out.queries.length, 6);
  assert.equal(out.tags.length, 3);
});

test('the prompt holds only name, description and the body truncated to ~6000 chars', async () => {
  const secret = 'sk-' + 'live-should-never-appear';
  process.env.HEADJACK_TOKEN_TEST_CANARY = secret;
  try {
    const body = `START${'x'.repeat(10000)}TAIL`;
    const generate = fakeGenerate(good);
    await enrichSkill({ ...skill, body }, { generate });
    const [arg] = generate.calls;
    assert.deepEqual(Object.keys(arg).sort(), ['prompt', 'system']);
    assert.ok(arg.prompt.includes(skill.name));
    assert.ok(arg.prompt.includes(skill.description));
    assert.ok(arg.prompt.includes('START'));
    assert.ok(!arg.prompt.includes('TAIL'), 'body is truncated');
    assert.ok(arg.prompt.length < MAX_BODY_CHARS + 1000);
    assert.ok(!arg.prompt.includes(secret) && !arg.system.includes(secret));
    assert.equal(MAX_BODY_CHARS, 6000);
  } finally {
    delete process.env.HEADJACK_TOKEN_TEST_CANARY;
  }
});

test('buildPrompt tolerates a missing body (plugin skills)', () => {
  const { prompt, system } = buildPrompt({ name: 'n', description: 'd' });
  assert.match(prompt, /n/);
  assert.match(system, /Spanish/);
});

test('the default model is the verified Gateway id and the schema accepts the expected shape', () => {
  if (!process.env.ENRICH_MODEL) assert.equal(enrichModel(), 'openai/gpt-5-mini');
  assert.equal(ENRICH_SCHEMA.safeParse(good).success, true);
  assert.equal(ENRICH_SCHEMA.safeParse({ queries_en: [] }).success, false);
});

test('normalizeTag makes lowercase kebab-case tags', () => {
  assert.equal(normalizeTag('  Podcast Mastering '), 'podcast-mastering');
  assert.equal(normalizeTag('three.js'), 'threejs');
  assert.equal(normalizeTag('state_machine'), 'state-machine');
  assert.equal(normalizeTag('--a--b--'), 'a-b');
  assert.equal(normalizeTag('!!!'), '');
  assert.equal(normalizeTag(7), '');
  assert.ok(normalizeTag('x'.repeat(80)).length <= 50);
  assert.ok(TAG_RE.test('podcast-mastering'));
  assert.ok(!TAG_RE.test('Podcast'));
});

test('mergeTags unions, normalizes, dedupes and caps at 8', () => {
  assert.equal(MAX_TAGS, 8);
  assert.deepEqual(mergeTags(['A', 'b'], ['b', 'C d'], undefined), ['a', 'b', 'c-d']);
  assert.equal(mergeTags(['1', '2', '3', '4', '5'], ['6', '7', '8', '9']).length, 8);
  assert.equal(tagsText(['a', 'c-d']), 'a c-d');
});

test('gatewayGenerate sends the instructions and prompt through generateObject and returns the parsed object (mock model, offline)', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(good) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    },
  });
  const out = await enrichSkill(skill, { generate: (p) => gatewayGenerate(p, { model }) });
  assert.equal(out.queries.length, 6);
  const [call] = model.doGenerateCalls;
  const text = JSON.stringify(call.prompt);
  assert.ok(text.includes('You write search data'), 'system instructions sent');
  assert.ok(text.includes('auphonic-mastering'), 'user prompt sent');
  assert.equal(call.responseFormat?.type, 'json');
});

// --- Fix round 1 ---

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('enrichSkill strips control characters and lone surrogates from queries and tags', async () => {
  const out = await enrichSkill(skill, {
    generate: fakeGenerate({
      queries_en: ['e\u0000f one', 'bell\u0007 two', 'ok \u{1F600} pair', 'lone \uD800high', 'lone \uDC00low'],
      queries_es: ['uno\u001b', 'dos\u000b\u007f'],
      tags: ['a\u0000b', 'c\u0001', 'd\uD800'],
    }),
  });
  assert.deepEqual(out.queries, ['ef one', 'bell two', 'ok \u{1F600} pair', 'lone high', 'lone low', 'uno', 'dos']);
  assert.deepEqual(out.tags, ['ab', 'c', 'd']);
});

test('clipping a long query never leaves half of a surrogate pair', async () => {
  const long = `${'x'.repeat(139)}\u{1F600}\u{1F600}`;
  const out = await enrichSkill(skill, { generate: fakeGenerate({ ...good, queries_en: [long, ...good.queries_en.slice(1)] }) });
  assert.ok(out.queries[0].length <= 140);
  assert.ok(!LONE_SURROGATE.test(out.queries[0]), 'no lone surrogate after the cut');
  assert.ok(out.queries.every((q) => !CONTROL.test(q)));
});

test('the enrichment and embedding models are read from the environment when used, not at import', () => {
  const saved = { ENRICH_MODEL: process.env.ENRICH_MODEL, EMBED_MODEL: process.env.EMBED_MODEL };
  try {
    process.env.ENRICH_MODEL = 'test/enrich-late';
    process.env.EMBED_MODEL = 'test/embed-late';
    assert.equal(enrichModel(), 'test/enrich-late');
    assert.equal(embedModel(), 'test/embed-late');
    delete process.env.ENRICH_MODEL;
    delete process.env.EMBED_MODEL;
    assert.equal(enrichModel(), 'openai/gpt-5-mini');
    assert.equal(embedModel(), 'openai/text-embedding-3-small');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('an empty model variable (as .env.example ships it) means the default model, not an empty model id', () => {
  const saved = { ENRICH_MODEL: process.env.ENRICH_MODEL, EMBED_MODEL: process.env.EMBED_MODEL };
  try {
    process.env.ENRICH_MODEL = '';
    process.env.EMBED_MODEL = '';
    assert.equal(enrichModel(), 'openai/gpt-5-mini');
    assert.equal(embedModel(), 'openai/text-embedding-3-small');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// --- Spanish-only backfill generation (T8) ---

const mockModel = (object, usage = { inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } }) => new MockLanguageModelV4({
  doGenerate: {
    content: [{ type: 'text', text: JSON.stringify(object) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  },
});

test('ENRICH_ES_SCHEMA asks for queries_es only', () => {
  assert.deepEqual(Object.keys(ENRICH_ES_SCHEMA.shape), ['queries_es']);
  assert.ok(ENRICH_ES_SCHEMA.safeParse({ queries_es: ['uno', 'dos'] }).success);
  assert.ok(!ENRICH_ES_SCHEMA.safeParse({ queries_en: ['one'] }).success);
});

test('enrichSpanish sends the skill prompt with a Spanish-only system prompt and returns cleaned queries and the usage', async () => {
  const calls = [];
  const usage = { inputTokens: 11, outputTokens: 7 };
  const generate = async (arg) => { calls.push(arg); return { object: { queries_es: ['  masterizar mi podcast ', 'MASTERIZAR MI PODCAST', '', 'nivelar el volumen', 'limpiar una voz', 'cuarta de sobra'] }, usage }; };
  const out = await enrichSpanish(skill, { generate });
  assert.deepEqual(out, { queries_es: ['masterizar mi podcast', 'nivelar el volumen', 'limpiar una voz'], usage });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, buildPrompt(skill).prompt, 'same name, description and body as the full enrichment');
  assert.match(calls[0].system, /Spanish/);
  assert.doesNotMatch(calls[0].system, /queries_en|tags/, 'the system prompt asks for nothing but Spanish queries');
});

test('enrichSpanish rejects fewer than 2 Spanish queries and a missing queries_es array', async () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  await assert.rejects(enrichSpanish(skill, { generate: async () => ({ object: { queries_es: ['solo una'] }, usage }) }), /1 Spanish queries, expected at least 2/);
  await assert.rejects(enrichSpanish(skill, { generate: async () => ({ object: { queries_en: ['a', 'b'] }, usage }) }), /queries_es/);
});

test('gatewayGenerateWithUsage returns the object and the token usage from generateObject, with the given schema (mock model, offline)', async () => {
  const model = mockModel({ queries_es: ['masterizar el audio de mi podcast', 'nivelar el volumen'] });
  const out = await gatewayGenerateWithUsage(buildPrompt(skill), { model, schema: ENRICH_ES_SCHEMA });
  assert.deepEqual(out, { object: { queries_es: ['masterizar el audio de mi podcast', 'nivelar el volumen'] }, usage: { inputTokens: 120, outputTokens: 30 } });
  const [call] = model.doGenerateCalls;
  assert.ok(JSON.stringify(call.prompt).includes('auphonic-mastering'), 'user prompt sent');
  assert.deepEqual(Object.keys(call.responseFormat?.schema?.properties ?? {}), ['queries_es'], 'the given schema reaches the model');
});

test('gatewayGenerateWithUsage maps missing token counts to 0', async () => {
  const model = mockModel({ queries_es: ['uno dos', 'tres cuatro'] }, { inputTokens: { total: undefined }, outputTokens: { total: undefined } });
  const { usage } = await gatewayGenerateWithUsage(buildPrompt(skill), { model, schema: ENRICH_ES_SCHEMA });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0 });
});

test('gatewayGenerate still returns the bare object, generated with ENRICH_SCHEMA', async () => {
  const model = mockModel(good);
  const out = await gatewayGenerate(buildPrompt(skill), { model });
  assert.deepEqual(out, good);
  assert.deepEqual(Object.keys(model.doGenerateCalls[0].responseFormat?.schema?.properties ?? {}).sort(), ['queries_en', 'queries_es', 'tags']);
});

test('limits helpers live in enrichment-limits and keep their behavior', async () => {
  const { LIMITS, cleanQueries, cleanTags } = await import('../../lib/enrichment-limits.mjs');
  assert.deepEqual(LIMITS, { en: [4, 5], es: [2, 3], tags: [3, 6] });
  assert.deepEqual(cleanQueries([' a  b ', 'A B', 'c'], new Set(), [2, 3], 'English'), ['a b', 'c']);
  assert.throws(() => cleanQueries(['a'], new Set(), [2, 3], 'English'), /returned 1 English queries, expected at least 2/);
  assert.deepEqual(cleanTags(['Foo Bar', 'foo-bar', 'baz', 'qux'], [3, 6]), ['foo-bar', 'baz', 'qux']);
  assert.throws(() => cleanTags(['a'], [3, 6]), /returned 1 tags/);
});
