import { defineConfig } from 'drizzle-kit';

// generate/check need no database. migrate needs the owner-role URL of the target branch, given explicitly in
// DATABASE_URL_OWNER. Read it at a hidden prompt and export it inside ( ... ), so it stays out of shell history and
// out of the shell (docs/operations.md, step 4), then run `npm run db:migrate` in that subshell.
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './drizzle',
  schemaFilter: ['public', 'auth', 'app'],
  dbCredentials: { url: process.env.DATABASE_URL_OWNER ?? '' },
});
