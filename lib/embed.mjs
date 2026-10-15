import { embedMany } from 'ai';

// Read on use, not at import: scripts load .env.local after their static imports have run.
export const embedModel = () => process.env.EMBED_MODEL || 'openai/text-embedding-3-small';
export const EMBED_DIMS = 1536;

export async function embedTexts(texts) {
  if (!texts.length) return [];
  const { embeddings } = await embedMany({ model: embedModel(), values: texts });
  for (const e of embeddings) {
    if (e.length !== EMBED_DIMS) throw new Error(`embedding has ${e.length} dims, expected ${EMBED_DIMS}`);
  }
  return embeddings;
}
