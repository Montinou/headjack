// The enrichment prompt, shared by the server-side enricher (lib/enrich.mjs) and the local one in the CLI. No npm
// dependencies: Node built-ins and ./ modules only.
// ENRICHMENT_VERSION identifies the prompt text and output shape that produced a stored enrichment. Bump it whenever
// SYSTEM, SYSTEM_ES or the prompt template changes (test/unit/enrich-prompt.test.mjs pins their hash).
export const ENRICHMENT_VERSION = 1;
export const MAX_BODY_CHARS = 6000;

export const SYSTEM = [
  'You write search data for a catalog of agent skills.',
  'Given one skill, return:',
  '- queries_en: 4-5 realistic requests in English, phrased the way a user asks an assistant for help (not documentation titles), each under 140 characters;',
  '- queries_es: 2-3 realistic requests in Spanish, same style, each under 140 characters;',
  '- tags: 3-6 lowercase kebab-case tags naming the tools, domains and tasks the skill covers.',
  'Vary the wording across queries. Do not mention the skill by name unless users would.',
].join('\n');

export const SYSTEM_ES = [
  'You write search data for a catalog of agent skills.',
  'Given one skill, return:',
  '- queries_es: 2-3 realistic requests in Spanish, phrased the way a user asks an assistant for help (not documentation titles), each under 140 characters.',
  'Vary the wording across queries. Do not mention the skill by name unless users would.',
].join('\n');

// Only the name, description and (truncated) SKILL.md body reach the model. `spanishOnly` selects the Spanish-only
// system text (the queries_es_text backfill); the prompt is the same either way.
export function buildPrompt({ name, description, body }, { spanishOnly = false } = {}) {
  const text = String(body ?? '').slice(0, MAX_BODY_CHARS);
  return {
    system: spanishOnly ? SYSTEM_ES : SYSTEM,
    prompt: `Skill name: ${name}\nDescription: ${description}\n\nSKILL.md body:\n${text || '(none)'}`,
  };
}

// Plain JSON Schema twins of ENRICH_SCHEMA / ENRICH_ES_SCHEMA in lib/enrich.mjs (zod), for callers without zod. Array
// bounds are not part of the schema: they are applied by cleanQueries/cleanTags with LIMITS.
const stringList = (description) => ({ type: 'array', items: { type: 'string' }, description });
const QUERIES_EN = stringList('4-5 realistic requests in English a user would type when they need this skill');
const QUERIES_ES = stringList('2-3 realistic requests in Spanish a user would type when they need this skill');

export const ENRICH_JSON_SCHEMA = {
  type: 'object',
  properties: { queries_en: QUERIES_EN, queries_es: QUERIES_ES, tags: stringList('3-6 lowercase kebab-case topic tags') },
  required: ['queries_en', 'queries_es', 'tags'],
};

export const ENRICH_ES_JSON_SCHEMA = {
  type: 'object',
  properties: { queries_es: QUERIES_ES },
  required: ['queries_es'],
};
