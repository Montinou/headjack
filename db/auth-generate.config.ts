// Schema generation only (`npm run auth:schema`): the exact Better Auth plugin set of spec §3, so db/auth-schema.ts
// has every table stage 2+ needs. Stage 2 builds the real lib/auth.ts with the same plugins and options.
// No database and no secrets here: the CLI runs with --adapter drizzle --dialect postgresql.
import { betterAuth } from 'better-auth';
import { deviceAuthorization, jwt, organization } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';

export const auth = betterAuth({
  baseURL: 'http://localhost:3000',
  socialProviders: { github: { clientId: 'schema-generation', clientSecret: 'schema-generation' } },
  plugins: [
    deviceAuthorization({ verificationUri: '/device' }),
    apiKey(),
    jwt(),
    mcp({ loginPage: '/login', consentPage: '/consent', resource: 'http://localhost:3000/mcp' }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    organization(),
  ],
});
