import { rankSkills } from '../search.mjs';
import { loadVec } from './vec.mjs';

// The query crosses the embedding boundary once. Fixed diagnostics keep query and Gateway bodies private.
export async function searchHybrid({ db, repo, query, embed, limit, tags, kind = null }) {
  const fullText = () => rankSkills({ repo, query, tags, k: limit, kind });
  if (!loadVec(db)) {
    console.error('vec unavailable');
    return fullText();
  }
  if (embed === undefined) return fullText();
  let vector;
  try {
    [vector] = await embed([query]);
  } catch {
    console.error('query embedding failed');
    return fullText();
  }
  return rankSkills({ repo, query, tags, k: limit, kind, embed: async () => [vector] });
}
