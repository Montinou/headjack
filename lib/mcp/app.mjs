import { createMcpHttp } from './transport.mjs';
import { loadMcpConfig } from './config.mjs';

let http;
let dependencies;

async function getDependencies() {
  if (!dependencies) {
    dependencies = (async () => {
      const config = loadMcpConfig(process.env);
      const [{ openAppDb }, { createIdentity }, { mcpOAuthResolver }, { repoForOwner }, { embedTexts }, { createMcpTools }] = await Promise.all([
        import('../app.mjs'), import('../identity.mjs'), import('./identity.mjs'),
        import('../repo.mjs'), import('../embed.mjs'), import('./tools.mjs'),
      ]);
      const db = openAppDb(process.env);
      let client;
      const resolver = mcpOAuthResolver({ config, getClient: async () => {
        client ??= (await import('@clerk/backend')).createClerkClient({
          secretKey: process.env.CLERK_SECRET_KEY,
          publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
        });
        return client;
      } });
      const identity = createIdentity({ resolvers: [resolver], resolveOwner: db.resolveOwner });
      const tools = createMcpTools({
        repoFor: (ownerId) => repoForOwner(db.withOwner, ownerId),
        embed: embedTexts, cursorSecret: config.cursorSecret,
        resolveFlags: async (_req, { ownerId, sessionId }) => {
          const { evaluateSearchFlags } = await import('../../flags.ts');
          return evaluateSearchFlags({ ownerId, sessionId });
        },
      });
      return { identify: identity.identify, tools, config };
    })().catch((error) => { dependencies = undefined; throw error; });
  }
  return dependencies;
}

export function mcpApp() {
  http ??= createMcpHttp({
    enabled: async () => (await import('../../flags.ts')).mcpReadOnly(),
    getMetadataConfig: () => loadMcpConfig(process.env),
    getDependencies,
  });
  return http;
}
