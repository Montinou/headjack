// Enrichment: synthetic user requests (English + Spanish) and tags for a skill, so search can match how people ask.
// Server/script-only (AI SDK + zod): never import this from cli/ or lib/handlers.mjs; inject it instead.
import { generateObject } from 'ai';
import { z } from 'zod';
import { normalizeTag } from './tags.mjs';
import { MAX_QUERY_CHARS, cleanQuery } from './enrichment-limits.mjs';

// Verified against the GatewayModelId union in node_modules/@ai-sdk/gateway (ai 7.0.x).
// Read on use, not at import: scripts load .env.local after their static imports have run.
export const enrichModel = () => process.env.ENRICH_MODEL || 'openai/gpt-5-mini';
export const MAX_BODY_CHARS = 6000;
export { MAX_QUERY_CHARS };
const LIMITS = { en: [4, 5], es: [2, 3], tags: [3, 6] };

export const ENRICH_SCHEMA = z.object({
  queries_en: z.array(z.string()).describe('4-5 realistic requests in English a user would type when they need this skill'),
  queries_es: z.array(z.string()).describe('2-3 realistic requests in Spanish a user would type when they need this skill'),
  tags: z.array(z.string()).describe('3-6 lowercase kebab-case topic tags'),
});

// Spanish only, for the queries_es_text backfill (scripts/backfill-queries-es.mjs): same limits and cleaning.
export const ENRICH_ES_SCHEMA = z.object({
  queries_es: z.array(z.string()).describe('2-3 realistic requests in Spanish a user would type when they need this skill'),
});

const SYSTEM = [
  'You write search data for a catalog of agent skills.',
  'Given one skill, return:',
  '- queries_en: 4-5 realistic requests in English, phrased the way a user asks an assistant for help (not documentation titles), each under 140 characters;',
  '- queries_es: 2-3 realistic requests in Spanish, same style, each under 140 characters;',
  '- tags: 3-6 lowercase kebab-case tags naming the tools, domains and tasks the skill covers.',
  'Vary the wording across queries. Do not mention the skill by name unless users would.',
].join('\n');

const SYSTEM_ES = [
  'You write search data for a catalog of agent skills.',
  'Given one skill, return:',
  '- queries_es: 2-3 realistic requests in Spanish, phrased the way a user asks an assistant for help (not documentation titles), each under 140 characters.',
  'Vary the wording across queries. Do not mention the skill by name unless users would.',
].join('\n');

// Only the name, description and (truncated) SKILL.md body reach the model.
export function buildPrompt({ name, description, body }) {
  const text = String(body ?? '').slice(0, MAX_BODY_CHARS);
  return {
    system: SYSTEM,
    prompt: `Skill name: ${name}\nDescription: ${description}\n\nSKILL.md body:\n${text || '(none)'}`,
  };
}

function cleanQueries(list, seen, [min, max], language) {
  const out = [];
  for (const item of list) {
    const q = cleanQuery(item); // '' for non-strings; strips control chars and lone surrogates, clips to 140
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length === max) break;
  }
  if (out.length < min) throw new Error(`enrichment returned ${out.length} ${language} queries, expected at least ${min}`);
  return out;
}

function cleanTags(list, [min, max]) {
  const out = [];
  for (const t of list) {
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
    if (out.length === max) break;
  }
  if (out.length < min) throw new Error(`enrichment returned ${out.length} tags, expected at least ${min}`);
  return out;
}

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
  const { prompt } = buildPrompt({ name, description, body });
  const { object: raw, usage } = await generate({ system: SYSTEM_ES, prompt });
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
