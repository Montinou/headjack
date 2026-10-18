# Migrations

Schema changes live in `drizzle/` (generated with `npm run db:generate` from `db/schema.ts`, plus the hand-written
`0001_app_foundation`, `0004_rls` and `0009_rename_app_role`) and are applied by the Vercel build, not by hand.

## In the Vercel build

Vercel runs `npm run vercel-build` (`scripts/vercel-build.mjs`) instead of `build`. `vercel.ts` sets this
`buildCommand` explicitly; keep the Vercel project's build setting in line with it.

With the Vercel Git integration, a merge into the production branch starts the production deployment: install
dependencies → apply the committed Drizzle migrations over the direct Neon connection → build Next.js → publish. A
migration failure stops the build and leaves the previous deployment serving. No separate CI job races the deployment
to migrate, and no production database URL needs to live in CI secrets. Commit the SQL and the Drizzle journal and
snapshot files with each schema change.

This follows the [Neon Drizzle migration guide](https://neon.com/docs/guides/drizzle-migrations) and
[Vercel build configuration](https://vercel.com/docs/builds/configure-a-build).

| `VERCEL_ENV` | Migrations | `next build` |
|---|---|---|
| `production` | yes | yes |
| `preview` | yes | yes |
| anything else, or unset | no | yes |

The build never changes the app role's password. The role is named `headjack_app`; its password is set out of band
with `scripts/set-app-password.mjs`, once per database branch. A Neon preview branch inherits the app password from its
parent, so Preview's `HEADJACK_APP_DB_PASSWORD` is the production one. The trade-off: Preview holds a
credential that also opens production, as the row-level-security-bound app role.

Migrations run over `DATABASE_URL_UNPOOLED` (the Neon integration's direct owner-role URL), on one session, inside
`pg_advisory_lock(MIGRATION_LOCK_KEY)` (`lib/build-migrate.mjs`: a fixed key, so running deployments share the lock), so
concurrent builds against one branch run one at a time. A missing `DATABASE_URL_UNPOOLED` fails the build, naming the
variable and never printing a value; so does an app-role URL that `lib/db.mjs` would reject, before any migration runs.
Any failure fails the build before `next build`. Logs show only `user@host/db`, the branch id, the environment
and migration counts.

## Which branch each build migrates

The build relies only on the variables Neon injects; there is no branch guard.

- **Preview** builds migrate the preview's own Neon branch (`preview/<git-branch>`) when the Neon integration has
  preview branching on, with "Require Active Resource Before Deploy", so a preview never deploys before Neon injects
  that branch's URL.
- **Production** builds migrate the branch Neon injects for Production (Production is not branched).

The build reads `current_setting('neon.branch_id', true)` and logs it for traceability; it never compares it.

## Backward-compatible rule

While a build migrates, the previous deployment keeps serving on the same database, and Vercel's instant rollback does
not roll the schema back. So every migration must work with the code that is live before it ships:

- **Expand, then contract.** Add new tables, columns (nullable or with a default) and indexes first; remove what is no
  longer read in a later release, once no deployment reads it.
- **Never drop or rename** a table, column, type, function or policy that the previous deployment still reads, in the
  same release that stops reading it. A rename is an add, a backfill, a switch of readers, and a later drop. The one
  accepted exception is renaming the app role, migration `0009_rename_app_role`: see the next section for its window and
  rollback.
- `0010_enrichment_version` follows this rule: a nullable column (`skills.enrichment_v`) and one data `UPDATE`, with no
  drop or rename. The previous deployment ignores the column.
- Before the first automated production migration, confirm the Neon project's instant-restore window, or take a
  backup branch once.

### The app-role rename (0009): window and rollback

`ALTER ROLE ... RENAME` applies in place, so it cannot be made backward-compatible. After 0009 commits, the deployment
still serving connects as a role that no longer exists and fails every request until the new deployment is promoted.
That takes minutes if the build succeeds. If `next build` fails, the window is unbounded until a build succeeds,
because `scripts/vercel-build.mjs` migrates before it builds. The build checks the app-role URL before it migrates
(`appDatabaseUrl` in `lib/db.mjs`, no connection opened), so a stale `DATABASE_URL_APP` or a missing app password fails
the build before 0009 runs.

If the build fails after 0009 applied, in this order:

1. **Fix forward.** Fix the build and redeploy. Drizzle has recorded 0009, so the retried build skips it and the new
   code finds `headjack_app`.
2. **Otherwise roll back.** Rolling back to any deployment older than 0009 (Vercel instant rollback, or redeploying an
   old commit) needs the rollback statements first. As the owner role, in one transaction:

   ```sql
   BEGIN;
   ALTER ROLE headjack_app RENAME TO <the name 0009 renames from: see drizzle/0009_rename_app_role.sql>;
   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791971865442;
   COMMIT;
   ```

   `1791971865442` is the `when` of the 0009 entry in `drizzle/meta/_journal.json`. The next release then re-applies
   0009, which is safe to run again.

This rollback only works while 0009 is the newest recorded migration. The migrator compares a migration only with the
newest row in `drizzle.__drizzle_migrations`, so once a later migration is recorded, deleting 0009's row changes
nothing: a later release would skip 0009 and connect as a role that no longer exists.

## Running them locally

Against a branch you choose, with its owner-role direct URL given explicitly (never picked up from `.env.local`). Read
it at a prompt rather than typing it on the command line, so the URL and its password stay out of your shell history.
The parentheses run it in a subshell, so the owner URL is gone once the migration ends and no later command in the same
shell can pick it up:

```sh
(
  printf 'Owner URL (no pooler): '; read -rs DATABASE_URL_OWNER; echo; export DATABASE_URL_OWNER
  npm run db:migrate
)
```

A local `npm run build` or `npm run vercel-build` without `VERCEL_ENV` never migrates.
