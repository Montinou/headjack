// Enrichment: synthetic user requests (English + Spanish) and tags for a skill, so search can match how people ask.
// Server/script-only (AI SDK + zod): never import this from cli/ or lib/handlers.mjs; inject it instead.
import { generateObject } from 'ai';
import { z } from 'zod';
import { MAX_QUERY_CHARS, LIMITS, cleanQueries, cleanTags } from './enrichment-limits.mjs';
import { buildPrompt, MAX_BODY_CHARS } from './enrich-prompt.mjs';

// Verified against the GatewayModelId union in node_modules/@ai-sdk/gateway (ai 7.0.x).
// Read on use, not at import: scripts load .env.local after their static imports have run.
export const enrichModel = () => process.env.ENRICH_MODEL || 'openai/gpt-5-mini';
export { MAX_QUERY_CHARS, MAX_BODY_CHARS, buildPrompt };

export const ENRICH_SCHEMA = z.object({
  queries_en: z.array(z.string()).describe('4-5 realistic requests in English a user would type when they need this skill'),
  queries_es: z.array(z.string()).describe('2-3 realistic requests in Spanish a user would type when they need this skill'),
  tags: z.array(z.string()).describe('3-6 lowercase kebab-case topic tags'),
});

// Spanish only, for the queries_es_text backfill (scripts/backfill-queries-es.mjs): same limits and cleaning.
export const ENRICH_ES_SCHEMA = z.object({
  queries_es: z.array(z.string()).describe('2-3 realistic requests in Spanish a user would type when they need this skill'),
});

export async function enrichSkill({ name, description, body }, { generate }) {
  const raw = await generate(buildPrompt({ name, description, body }));
  if (!raw || !Array.isArray(raw.queries_en) || !Array.isArray(raw.queries_es) || !Array.isArray(raw.tags)) {
    throw new Error('enrichment output must have queries_en, queries_es and tags arrays');
  }
  const seen = new Set();
  const en = cleanQueries(raw.queries_en, seen, LIMITS.en, 'English');
  const es = cleanQueries(raw.queries_es, seen, LIMITS.es, 'Spanish');
  // Each language stays apart (Spanish feeds queries_es_text); `queries` is their concatenation, for the chunks.
  return { queries_en: en, queries_es: es, queries: [...en, ...es], tags: cleanTags(raw.tags, LIMITS.tags) };
}

// Spanish queries only, from the same prompt input. `generate` returns { object, usage } (gatewayGenerateWithUsage
// bound to ENRICH_ES_SCHEMA); the usage is passed through so the backfill can report token cost.
export async function enrichSpanish({ name, description, body }, { generate }) {
  const { object: raw, usage } = await generate(buildPrompt({ name, description, body }, { spanishOnly: true }));
  if (!raw || !Array.isArray(raw.queries_es)) throw new Error('enrichment output must have a queries_es array');
  return { queries_es: cleanQueries(raw.queries_es, new Set(), LIMITS.es, 'Spanish'), usage };
}

// Real generator: AI SDK generateObject through AI Gateway (auth from AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN).
// `model` is overridable only so tests can pass a mock model; `instructions` is ai@7's name for the system prompt.
// Returns the parsed object and the token usage as { inputTokens, outputTokens } (a count the provider omits is 0).
export async function gatewayGenerateWithUsage({ system, prompt }, { model = enrichModel(), schema } = {}) {
  const { object, usage } = await generateObject({ model, schema, instructions: system, prompt });
  return { object, usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 } };
}

export async function gatewayGenerate({ system, prompt }, { model = enrichModel() } = {}) {
  const { object } = await gatewayGenerateWithUsage({ system, prompt }, { model, schema: ENRICH_SCHEMA });
  return object;
}
