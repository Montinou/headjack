import { flag } from 'flags/next';
import { vercelAdapter } from '@flags-sdk/vercel';

// Independent premium workspace rollout; false preserves the original account/placeholder UI.
export const premiumUi = flag<boolean>({
  key: 'premium-ui',
  description: 'Enable the premium private knowledge workspace',
  defaultValue: false,
  adapter: vercelAdapter,
});

// Clerk UI + identity rollout. Authorization stays enforced by each API handler.
export const clerkAuth = flag<boolean>({
  key: 'clerk-auth',
  description: 'Enable Clerk sign-in and private user authentication',
  defaultValue: false,
  adapter: vercelAdapter,
});

export const mcpReadOnly = flag<boolean>({
  key: 'mcp-readonly',
  description: 'Enable the read-only Clerk OAuth MCP endpoint and discovery',
  defaultValue: false,
  adapter: vercelAdapter,
});

// CLI OAuth login discovery (/.well-known/oauth-protected-resource/api); false answers 404.
export const cliOauth = flag<boolean>({
  key: 'cli-oauth',
  description: 'Enable CLI OAuth login discovery',
  defaultValue: false,
  adapter: vercelAdapter,
});

// The entities search flags are evaluated for; `vercel flags split --by session.id` targets session.id.
type SearchEntities = { owner: { id: number }; session: { id: string } };
type Ranking = 'rrf-english' | 'rrf-bilingual';

// Kill switch for the Spanish full-text branch of search (spec 2026-09-29 §3.6).
export const bilingualFts = flag<boolean, SearchEntities>({
  key: 'search-bilingual-fts',
  description: 'Kill switch for the Spanish full-text branch of search',
  defaultValue: false,
  adapter: vercelAdapter,
});

// A/B of the full-text path, split by session (spec 2026-09-29 §3.6). A missing remote flag resolves to control.
export const searchRanking = flag<Ranking, SearchEntities>({
  key: 'search-ranking',
  description: 'Full-text ranking path of search: rrf-english (control) or rrf-bilingual',
  defaultValue: 'rrf-english',
  options: ['rrf-english', 'rrf-bilingual'],
  adapter: vercelAdapter,
});

// Evaluates both search flags for an owner and session already resolved by the handler: no identity or database
// lookup of its own. lib/app.mjs loads this module with a dynamic import, only when a search runs.
export async function evaluateSearchFlags({ ownerId, sessionId }: { ownerId: number; sessionId: string }) {
  const identify: SearchEntities = { owner: { id: ownerId }, session: { id: sessionId } };
  const [fts, ranking] = await Promise.all([bilingualFts.run({ identify }), searchRanking.run({ identify })]);
  return { bilingualFts: fts, ranking };
}
