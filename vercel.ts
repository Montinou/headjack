import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'npm run vercel-build',
  crons: [{ path: '/api/cron/check-upstream', schedule: '0 6 * * 1' }],
};
