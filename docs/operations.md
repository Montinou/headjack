# Operating the Headjack instance

This document is for the maintainers of the hosted Headjack instance. It records how the instance is built, configured and
checked, so that anyone who maintains it can rebuild a broken piece or rotate a credential. It is not an invitation to run
another instance: the hosted instance is invite-only and run by the Headjack maintainers, and the supported ways for
everyone else to use Headjack are the local CLI and the local MCP server (see the [README](../README.md)).

The instance is one Vercel project with a Neon Postgres database that has the `vector` extension, a Clerk application, and
an embeddings provider. Embeddings and enrichment go through the Vercel AI Gateway; the default embedding model is
`openai/text-embedding-3-small` (1536 dimensions, which the index expects). The hosted mode needs Node 20.9 or later and
never loads SQLite.

Instance values (its address, its OAuth client ids, its project and database identifiers, the owner's address) are not
recorded in this repository. Where a host is needed, the examples use `headjack.example.invalid`; the real values live in
the Vercel project, the Clerk Dashboard and the maintainers' own notes.

## How the instance is built

The instance was set up in this order. Maintainers repeat a step to rebuild one piece of it (a new database branch, a
recreated project, a rotated key). Each step says why it is there. Steps 1 to 8 are the deployment; steps 9 to 12 sign a
maintainer in and connect a machine.

1. **The Vercel project.** The instance's Vercel project imports this repository; `vercel.ts` sets the build command to
   `npm run vercel-build` and a weekly cron for upstream checks. *Why:* the web app, the REST API and the cron run
   on it.
2. **The database.** The instance's Neon database comes from the Vercel Marketplace; the integration injects
   `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, and its preview branching gives one database branch per preview. *Why:*
   the vault lives in Postgres, and the `vector` extension powers search.

   Neon limits the project to 10 branches, and each Vercel preview creates `preview/<git-branch>`. Past the limit the
   preview fails with "Resource provisioning failed" (observed in production on 2026-10-17; the limit and the message come
   from Neon and Vercel, not from this repository). Delete the preview branches of merged pull requests, or enable the
   integration's automatic deletion of them.
3. **Migrations need no manual step.** Every production and preview build applies the committed migrations in `drizzle/`
   before `next build` (see [`migrations.md`](migrations.md)). Migrations `0001_app_foundation` and `0009_rename_app_role`
   leave the app role `headjack_app`, without a login. Migration `0010_enrichment_version` adds the nullable column
   `skills.enrichment_v` and sets it to 1 where `queries_es_text <> ''`; it makes no model call. *Why:* the schema and
   the row-level-security policies arrive with the deploy.
4. **The app role has a password**, set once per database branch with the owner-role URL given explicitly. A maintainer
   reads both values at a prompt rather than typing them on the command line, so they stay out of the shell history.
   The parentheses run the step in a subshell, so neither variable outlives the one command that needs it:

   ```sh
   (
     printf 'Owner URL (no pooler): '; read -rs DATABASE_URL_OWNER; echo; export DATABASE_URL_OWNER
     printf 'App password (32+ characters): '; read -rs HEADJACK_APP_DB_PASSWORD; echo; export HEADJACK_APP_DB_PASSWORD
     node scripts/set-app-password.mjs
   )
   ```

   The same `HEADJACK_APP_DB_PASSWORD` is set in Vercel. The app connects only as `headjack_app`, built from
   `DATABASE_URL` and that password, or from an explicit `DATABASE_URL_APP`. *Why:* the app never connects as the
   owner role, so the row-level-security policies always apply.
5. **Clerk.** *Why:* Clerk signs users in on the web and issues the API key the CLI uses, so both reach the same
   vault.
   - The instance's Clerk application was created directly in Clerk or through the Vercel Marketplace, which injects the
     two keys.
   - In its Dashboard, sign-up is **Restricted** (invitation only); the maintainer's own address and each invited user
     are invited. Anyone else who tries to sign up is refused.
   - On the Dashboard's **API keys** page, **User API keys** is enabled (the CLI token step below needs it).
   - `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are set in Vercel (the Marketplace does this when it
     created the application), and `CLERK_AUTHORIZED_PARTIES` is the exact origin of the instance, for example
     `https://headjack.example.invalid`.
6. **The flags are on.** Vercel Flags is connected (`FLAGS`, `FLAGS_SECRET`) and two flags are **on**:
   `clerk-auth` (Clerk sign-in and identity) and `premium-ui` (the web UI). Every flag defaults to off or to its
   control value, so without them Clerk is off and **every user API request is refused (401), because Clerk is the
   only way in**, and **with `premium-ui` off the site shows only a placeholder page** ("API only for now"). The other
   flags (`mcp-readonly`, `cli-oauth`, `search-bilingual-fts`, `search-ranking`) are optional; `cli-oauth` enables
   `headjack login` and `mcp-readonly` enables `/mcp`. *Why:* nothing user-facing is switched on by default.
7. **The AI Gateway** is connected (`AI_GATEWAY_API_KEY` locally; on Vercel the OIDC token is used). *Why:* embeddings and
   skill enrichment go through it.

   After a deploy that raises `ENRICHMENT_VERSION` (`lib/enrich-prompt.mjs`), re-enrich the Spanish example requests
   written by the older prompt with `node scripts/backfill-queries-es.mjs --stale`. Run it again without `--stale` for
   the rows that hold no text, because rows written by the old code during the build can have `''` with a version, which
   only the default mode picks up. It makes one model call per skill and writes only `queries_es_text` and
   `enrichment_v`. The other flags are `--dry-run` (also prints the generated queries), `--limit N`,
   `--only slug1,slug2` and `--force` (every current version; it overrides `--stale`). It runs as the app role for one
   owner (`HEADJACK_OWNER_ID`, else the initial owner), so it needs `DATABASE_URL_APP` or `DATABASE_URL` with
   `HEADJACK_APP_DB_PASSWORD`, and the AI Gateway credential (`VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`), from the
   environment or `.env.local`. It exits 1 when any skill failed.
8. **Deploys.** A push to the production branch (or `vercel deploy --prod`) builds, and the build runs the
   migrations. *Why:* the variables and flags above take effect on a new deployment.
9. **Invitations are accepted on the instance.** An invited person chooses **Accept invitation** and finishes the
   sign-up with the invited address. *Why:* the Clerk user (`user_…`) does not exist until the invitation is accepted, and the next
   step needs its id. The id is in the Clerk Dashboard under **Users**. This needs the deployment from step 8
   and both flags from step 6.
10. **The CLI token is a Clerk API key for a user.** The CLI is installed first (README, "Quickstart: local", step 2);
    then, from a clone with `npm ci` done, a maintainer creates a key with the `skills:read` and `skills:write` scopes (the server refuses a
    key without the scope for the operation) and write it straight into the token file, so it is never printed. The
    secret key is the one set in step 5; the user id is the one from step 9. The token goes to `$HEADJACK_HOME/token`
    when `HEADJACK_HOME` is set (an absolute path), else to `~/.headjack/token`:

    ```sh
    STATE="${HEADJACK_HOME:-$HOME/.headjack}"
    mkdir -p "$STATE" && chmod 700 "$STATE"
    (
      umask 077
      printf 'Clerk secret key: '; read -rs CLERK_SECRET_KEY; echo; export CLERK_SECRET_KEY
      printf 'Clerk user id (user_...): '; read -r CLERK_USER_ID; export CLERK_USER_ID
      node --input-type=module -e '
        import { createClerkClient } from "@clerk/backend";
        const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
        const key = await clerk.apiKeys.create({
          subject: process.env.CLERK_USER_ID, name: "headjack-cli", scopes: ["skills:read", "skills:write"],
          secondsUntilExpiration: 60 * 60 * 24 * 365,
        });
        if (!key.secret) throw new Error("Clerk returned no secret for the new API key");
        process.stdout.write(key.secret);
      ' > "$STATE/token.new" && mv "$STATE/token.new" "$STATE/token" && chmod 600 "$STATE/token" \
        || { rm -f "$STATE/token.new"; exit 1; }
    )
    ```

    The key is written to a temporary file and moved into place only when it was created, so a failed run leaves any
    existing token untouched. A Clerk API key resolves to the same owner as the user's web session (`clerk:<user id>`),
    so the web and the CLI share one vault. Each run mints a new key that expires after a year; revoke the ones no
    longer in use under **API keys** in the Clerk Dashboard. A revoked key can keep working for a minute or two while
    verification results are cached, so revoke before the key must be gone. *Why:* the API key is the credential for a
    machine without a browser, or when `cli-oauth` is off; otherwise `headjack login` needs no key.

    A key that expired (the CLI then gets 401) is rotated by creating a new one as above, which replaces the token file,
    and revoking the old one.
11. **Optionally, `config.json`** in the state directory holds `excludedRoots` (and `corePlugins`), written before
    importing or installing anything. *Why:* directories listed there (a work folder, say) are never imported from or installed
    into; see "State directory and `config.json`" in the [README](../README.md). The same file holds the `suggest` and
    `enrich` sections that configure skill suggestions and local enrichment (`lib/suggest-config.mjs`); see
    "Suggestions" in the README.
12. **Verification.** With `HEADJACK_URL` pointing at the instance:

    ```sh
    headjack search "something you expect to find"
    headjack harness detect
    ```

    On a fresh database the vault is empty, so the search prints no results: an empty result without an error is
    what proves the key works. A `403` with "missing required skill scope" means the key's scopes are wrong; create
    it again with `skills:read` and `skills:write`. Once skills have been added, the search returns the same vault the
    web shows; `harness detect` records which agent harnesses the machine has.

**One identity, one vault.** Clerk is the only way to authenticate: a session, an OAuth grant or an API key all
resolve to a Clerk user, and each Clerk user maps to its own owner (`clerk:<user id>`) with its own private vault. No
shared secret identifies a user; the only bearer secret the server takes is `CRON_SECRET`, on the cron route. A vault
that predates Clerk belongs to the initial owner (`legacy:v1`); to bring it into a Clerk user, run
`select app.bind_clerk_legacy_owner('clerk:<user id>')` once, as the owner role, before that user's first sign-in; it
refuses when the Clerk user already has a vault.

**Optional pieces**, none needed for the path above: the MCP server ([`mcp.md`](mcp.md); behind the `mcp-readonly` flag),
the cron secret `CRON_SECRET` (Vercel Cron sends it to the upstream-check route), `GITHUB_TOKEN` (raises the GitHub
rate limit for upstream checks) and search telemetry (`SEARCH_EVENTS_HMAC_KEY`; without it, search exposure events
are not recorded). The key covers both `GET /api/search` and the `POST /api/search` that hosted suggestions use: a
`suggest` search with a valid session id stores an HMAC of the query, never its text.

## Inviting a user

An invited user needs three things: an accepted Clerk invitation, the instance address and, for the hosted MCP route, the
public `headjack-mcp` client id. The invitation carries the address and the client id; they are not published in this
repository. After accepting, the user runs `headjack login` as described in the README ("Hosted (invite-only)"). The
`cli-oauth` flag must be on for `headjack login`, and `mcp-readonly` for `/mcp`.

## Pull requests from forks

A preview build runs the pull request's own code with the Preview environment variables. Those reach production data:
Preview holds the production `HEADJACK_APP_DB_PASSWORD`, and its database branch is copied from production (see
[`migrations.md`](migrations.md)). So a maintainer never authorizes a Vercel deployment for a pull request from a fork
(Vercel asks for an explicit "Authorize" on each one), and never pushes a contributor's commits to a branch of this
repository before reviewing them, because that deploys them without the prompt. GitHub CI, which gets no secrets for a
fork, is the check for outside pull requests. Keep Vercel's Git fork protection on in the project settings: it is what
makes that "Authorize" prompt appear.

## Environment variables

[`.env.example`](../.env.example) lists every variable the app, the scripts and the CLI read, with a one-line comment
each; `test/unit/env-example.test.mjs` keeps it complete. In short:

| Area | Variables |
|---|---|
| Database | `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `DATABASE_URL_APP`, `HEADJACK_APP_DB_PASSWORD`, `DATABASE_URL_OWNER` |
| Authentication | `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_AUTHORIZED_PARTIES` |
| Flags | `FLAGS`, `FLAGS_SECRET` |
| AI | `AI_GATEWAY_API_KEY` (also read by `headjack enrich`), `VERCEL_OIDC_TOKEN`, `EMBED_MODEL`, `ENRICH_MODEL` |
| Server jobs | `CRON_SECRET`, `GITHUB_TOKEN`, `SEARCH_EVENTS_HMAC_KEY` |
| OAuth | `HEADJACK_AUTH_SERVER_URL`, `HEADJACK_API_RESOURCE_URL`, `HEADJACK_CLI_CLIENT_ID` |
| MCP | `MCP_RESOURCE_URL`, `MCP_ALLOWED_ORIGINS`, `MCP_CURSOR_SECRET` |
| Scripts | `HEADJACK_OWNER_ID`, `HEADJACK_OVERRIDE_CONTROL`, `HEADJACK_OVERRIDE_BILINGUAL`, `TARGET`, `VERCEL_AUTOMATION_BYPASS_SECRET` |
| CLI | `HEADJACK_MODE`, `HEADJACK_URL`, `HEADJACK_TOKEN`, `HEADJACK_HOME`, `HEADJACK_PURPOSE`, `HEADJACK_EXCLUDED_ROOTS`, `HEADJACK_UPDATE_TTL_HOURS`, `HEADJACK_DEBUG`, `HEADJACK_MCP_TIMEOUT_MS` |

For local work on the app, copy `.env.example` to `.env.local` (git ignores it) and fill in what you use. Never commit a
value, and never paste one into an issue or a chat.
