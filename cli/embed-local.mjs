// Local chunk embeddings. One POST to the AI Gateway embeddings endpoint, using the same key helper as Spanish
// enrichment. The CLI imports no npm package and does not import lib/embed.mjs. Texts and response bodies are never logged.
export { aiGatewayKey } from './enrich-local.mjs';

const EMBEDDINGS_URL = 'https://ai-gateway.vercel.sh/v1/embeddings';
const DIMS = 1536;

function finiteVector(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== DIMS) throw new Error('embedding length is not 1536');
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) throw new Error('embedding values are not finite numbers');
  }
  return embedding;
}

function vectorsOf(body, count) {
  if (!Array.isArray(body?.data) || body.data.length !== count) throw new Error('embedding length is not 1536');
  const vectors = new Array(count);
  const seen = new Set();
  for (const row of body.data) {
    const index = row?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) {
      throw new Error('embedding indexes are not 0..n-1');
    }
    seen.add(index);
    vectors[index] = finiteVector(row?.embedding);
  }
  return vectors;
}

// Resolves number[][] only when indexes are exactly 0..n-1 and every vector is 1536 finite numbers. Any other response rejects.
// `model` defaults to EMBED_MODEL, then openai/text-embedding-3-small. `fetchImpl` defaults to global fetch.
export async function embedTexts({
  texts,
  key,
  model = process.env.EMBED_MODEL || 'openai/text-embedding-3-small',
  fetchImpl = fetch,
}) {
  let res;
  try {
    res = await fetchImpl(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts, dimensions: DIMS }),
    });
  } catch {
    throw new Error('request failed (network error)');
  }
  if (!res?.ok) throw new Error(`gateway returned HTTP ${res?.status ?? 'error'}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('response is not valid JSON');
  }
  return vectorsOf(body, Array.isArray(texts) ? texts.length : -1);
}
