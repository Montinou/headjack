import { collapseInstalls, qualityPrior } from './rank.mjs';
import { rrf } from './rrf.mjs';
const CANDIDATES = 50;

// Shared REST/MCP ranking. Preserve quality for MCP; REST removes it at its response boundary.
export async function rankSkills({ repo, embed, query, tags, k, kind = null, variant }) {
  // No embedder (local mode): text search alone, the vector branch is skipped.
  let vector;
  if (embed !== undefined) {
    try {
      [vector] = await embed([query]);
    } catch (e) {
      throw new Error('query embedding failed: ' + e.message);
    }
  }
  const [byVector, byText] = await Promise.all([
    embed === undefined ? [] : repo.searchVector(vector, CANDIDATES, tags),
    repo.searchText(query, CANDIDATES, tags, { bilingual: variant === 'rrf-bilingual' }),
  ]);
  const fused = rrf([byVector.map((r) => r.id), byText]);
  const vectorHits = new Map(byVector.map((r, i) => [r.id, { rank: i + 1, sim: r.sim }]));
  const ftsRanks = new Map(byText.map((id, i) => [id, i + 1]));
  const signals = (id) => {
    const v = vectorHits.get(id);
    const fts = ftsRanks.get(id);
    return {
      fts_rank: fts ?? null,
      vector_rank: v?.rank ?? null,
      similarity: v?.sim ?? null,
      matched: v && fts ? 'both' : v ? 'vector' : 'fts',
      variant,
    };
  };
  const rows = new Map((await repo.getSkillsByIds(fused.map((r) => r.id))).map((r) => [r.id, r]));
  const ranked = fused
    .filter((r) => rows.has(r.id))
    .map((r) => ({ id: r.id, row: rows.get(r.id), score: r.score + qualityPrior(rows.get(r.id).quality) }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .map(({ row: { id, ...row }, score }) => ({ ...row, score, ...signals(id) }))
    .filter((r) => !kind || r.kind === kind);
  return collapseInstalls(ranked).slice(0, k);
}
