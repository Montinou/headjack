import { apiOAuthMetadata } from '../../../../lib/api-oauth-metadata.mjs';

const discovery = apiOAuthMetadata({
  isEnabled: async () => (await import('../../../../flags.ts')).cliOauth(),
  env: process.env,
});

export const runtime = 'nodejs';
export function GET(req: Request) { return discovery.metadata(req); }
export function OPTIONS(req: Request) { return discovery.options(req); }
