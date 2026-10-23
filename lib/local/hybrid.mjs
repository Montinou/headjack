import { findSecrets } from '../../cli/scan.mjs';
import { rankSkills } from '../search.mjs';
import { isBusy, isDamaged } from './schema.mjs';
import { loadVec } from './vec.mjs';

// The query crosses the embedding boundary once. Fixed diagnostics keep query and Gateway bodies private.
// readSnapshot lets suggestions read their decision signals and ranking together, after the Gateway await.
export async function searchHybrid({ db, repo, query, embed, limit, tags, kind = null, readSnapshot = read => read() }) {
  const fullText = () => readSnapshot(() => rankSkills({ repo, query, tags, k: limit, kind }));
  if (!loadVec(db)) {
    console.error('vec unavailable');
    return fullText();
  }
  if (embed === undefined) return fullText();
  // Scan the exact outbound text, including segments findSecrets would otherwise treat as binary.
  if (findSecrets(query.split('\0').map((text, index) => ({ path: `query-${index}.txt`, data: Buffer.from(text) }))).length) {
    return fullText();
  }
  let vector;
  try {
    [vector] = await embed([query]);
  } catch {
    console.error('query embedding failed');
    return fullText();
  }
  const fallbackRepo = {
    ...repo,
    async searchVector(...args) {
      try { return await repo.searchVector(...args); }
      catch (error) {
        if (isBusy(error) || isDamaged(error) || error?.code === 'vault_damaged') throw error;
        console.error('vec unavailable');
        return [];
      }
    },
  };
  return readSnapshot(() => rankSkills({ repo: fallbackRepo, query, tags, k: limit, kind, embed: async () => [vector] }));
}
