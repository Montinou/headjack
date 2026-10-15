// Flags Explorer discovery endpoint (vercel:flags-sdk skill). Only the flag declarations are listed, not the
// evaluation helper that flags.ts also exports.
import { createFlagsDiscoveryEndpoint } from 'flags/next';
import { getProviderData } from '@flags-sdk/vercel';
import { bilingualFts, searchRanking } from '../../../../flags';

export const GET = createFlagsDiscoveryEndpoint(async () => {
  return getProviderData({ bilingualFts, searchRanking });
});
