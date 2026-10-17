import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ENRICHMENT_VERSION, SYSTEM, SYSTEM_ES, MAX_BODY_CHARS, buildPrompt, ENRICH_JSON_SCHEMA, ENRICH_ES_JSON_SCHEMA } from '../../lib/enrich-prompt.mjs';
import { ENRICH_SCHEMA, ENRICH_ES_SCHEMA } from '../../lib/enrich.mjs';
import { importGraph } from '../import-scanner.mjs';

const fixture = { name: 'pin', description: 'Pinned fixture', body: 'Body.' };
// Pinned from the prompt text before it moved out of lib/enrich.mjs.
const PROMPT_HASH = '1ec563ec479bd1854316daf790974e14e01268330dc0f9e3b7eb693870f0cfcd';

test('the prompt text is pinned: when this hash changes, bump ENRICHMENT_VERSION and update the pin together', () => {
  const hash = createHash('sha256').update(SYSTEM + SYSTEM_ES + buildPrompt(fixture).prompt).digest('hex');
  assert.equal(hash, PROMPT_HASH, 'prompt text changed: bump ENRICHMENT_VERSION (lib/enrich-prompt.mjs) and update PROMPT_HASH');
  assert.equal(ENRICHMENT_VERSION, 1);
  assert.equal(MAX_BODY_CHARS, 6000, 'the body limit shapes the prompt: changing it needs a version bump too');
});

test('buildPrompt picks the system text by spanishOnly and truncates the body', () => {
  assert.equal(buildPrompt(fixture).system, SYSTEM);
  assert.equal(buildPrompt(fixture, { spanishOnly: false }).system, SYSTEM);
  assert.equal(buildPrompt(fixture, { spanishOnly: true }).system, SYSTEM_ES);
  assert.equal(buildPrompt(fixture, { spanishOnly: true }).prompt, buildPrompt(fixture).prompt);
  assert.match(buildPrompt({ ...fixture, body: '' }).prompt, /SKILL\.md body:\n\(none\)$/);
  const long = buildPrompt({ ...fixture, body: 'x'.repeat(MAX_BODY_CHARS + 500) }).prompt;
  assert.equal(long.split('SKILL.md body:\n')[1].length, MAX_BODY_CHARS);
});

const shape = (schema) => Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, [v.type, v.items?.type, v.description]]));

test('the plain JSON Schemas match the zod schemas in property names, types and descriptions', () => {
  assert.deepEqual(shape(ENRICH_JSON_SCHEMA), shape(z.toJSONSchema(ENRICH_SCHEMA)));
  assert.deepEqual(shape(ENRICH_ES_JSON_SCHEMA), shape(z.toJSONSchema(ENRICH_ES_SCHEMA)));
  assert.deepEqual([...ENRICH_JSON_SCHEMA.required].sort(), ['queries_en', 'queries_es', 'tags']);
  assert.deepEqual(ENRICH_ES_JSON_SCHEMA.required, ['queries_es']);
  for (const s of [ENRICH_JSON_SCHEMA, ENRICH_ES_JSON_SCHEMA]) {
    assert.equal(s.type, 'object');
    for (const p of Object.values(s.properties)) assert.ok(!('minItems' in p) && !('maxItems' in p), 'bounds stay in cleanQueries/LIMITS');
  }
});

test('the prompt and limits modules import nothing outside node: and ./', async () => {
  for (const entry of ['lib/enrich-prompt.mjs', 'lib/enrichment-limits.mjs']) {
    const { external, files } = await importGraph(entry);
    assert.deepEqual(external.filter((s) => !s.startsWith('node:')), [], entry);
    assert.ok(!files.includes('lib/enrich.mjs'), entry);
  }
});
