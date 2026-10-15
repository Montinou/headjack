# Clerk identity and Neon isolation

Clerk is the identity provider. Neon stores vault data, with the existing restricted `headjack_app` role and
forced PostgreSQL row-level security. Neon Auth and the Data API are not part of the application request path.
Do not expose the SQL application credentials to a browser, CLI, or MCP client.

## Request path

1. `clerk-auth` gates Clerk UI and API identity. The legacy bearer resolver is retired: with the flag off, every API request is 401.
2. The official Clerk Backend SDK verifies session, OAuth, or user API-key credentials against the configured
   instance. Organization API keys and M2M credentials are not accepted as personal identities.
3. Session credentials require a currently active session. Every credential requires a current, unbanned,
   unlocked user whose primary email is verified. These checks precede the cached owner lookup.
4. The immutable `clerk:<userId>` subject resolves to an internal owner. No email, name, organization, request
   header or query parameter can select another owner.
5. Every repository operation runs in `withOwner`: begin, transaction-local `app.owner_id`, query, commit/rollback.
   RLS filters reads and checks writes. Unset owner context reveals no private rows. Pool reuse does not retain it.

Clerk remains the source of truth for user profiles and account state; no profile copy or eventual webhook sync
is required. Account checks add Backend API latency and consume its rate limit. An unavailable identity service
fails closed; it never grants access based on stale cached admission. Deleted accounts lose access; their data
is retained until an explicit data-deletion operation.

## Configuration and client permissions

- Vercel's Clerk integration supplies `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` per environment.
- `CLERK_AUTHORIZED_PARTIES` is a comma-separated list of exact trusted origins, including protocol. Production
  uses the custom domain and its approved Vercel alias. HTTP is allowed only for local development loopback hosts.
  There is no wildcard or request-derived fallback. Preview origins come from `VERCEL_URL` and
  `VERCEL_BRANCH_URL`; Clerk access on Preview is gated by the `clerk-auth` flag.
- Signed-in browser writes require a trusted `Origin`, including session JWTs sent in Authorization headers.
- OAuth and individual API keys require `skills:read` for GET/HEAD/OPTIONS and `skills:write` for mutations.
  A client needing both must request both. OIDC `openid`, `profile`, and `email` scopes do not grant vault access.
  Token issuance and the CLI/MCP OAuth client rollout are separate from this server-side integration.
- REST OAuth tokens are resource-bound. A bearer starting with `oat_` is verified once per request with the provider,
  with the audience `HEADJACK_API_RESOURCE_URL` (canonical `https://<host>/api`): revoked, expired, missing-audience and
  wrong-audience tokens get 401, a missing scope 403, and a provider outage the existing 500 "identity service
  unavailable". The live user checks still apply. When `HEADJACK_API_RESOURCE_URL` or `HEADJACK_AUTH_SERVER_URL` is
  unset, REST rejects every OAuth token (401). `authenticateRequest` accepts only `session_token` and `api_key`; any
  other bearer that is not `oat_` (for example a JWT-format OAuth access token) is rejected with 401. Both Clerk
  instances issue opaque OAuth access tokens. An MCP token (audience `/mcp`) therefore cannot be replayed on REST, and a
  CLI token (audience `/api`) cannot be used on the MCP.
- Preview trusts its own deployment origins. When `VERCEL_ENV` is `preview`, the resolver adds `https://$VERCEL_URL`
  and `https://$VERCEL_BRANCH_URL` (when set) to `CLERK_AUTHORIZED_PARTIES`, and an empty configured list is allowed on
  Preview only. Vercel sets these values on the server; they are never derived from request headers. Production and
  Development are unchanged: an empty list still throws there.
- `GET /.well-known/oauth-protected-resource/api` (RFC 9728) is the CLI's discovery route, gated by the `cli-oauth`
  flag: 404 when off, 503 when misconfigured, 200 with `headjack_cli_client_id` otherwise. Turning the flag off does not
  affect REST verification of tokens already issued.
- Clerk restricted signup controls admission. The initial account was created explicitly by the operator with a
  reserved email, without an invented password or outbound invitation. Email-code sign-in verifies its address.

## Existing vault ownership

Migration `0006_clerk_owner_aliases` creates an operator-only alias table. The initial Clerk account is bound to
the existing legacy owner through `app.bind_clerk_legacy_owner('clerk:<userId>')`, executed with the migration role
only after the operator confirms account and data ownership. Neither the email nor the account ID is hardcoded
in the migration. It changes no skill, version, source, chunk, blob, or event owner IDs.

`app.resolve_owner` recognizes the alias, while the existing legacy reference continues to resolve to the same
owner. Binding is idempotent, refuses a second account, and refuses implicit merging with a previously created
canonical owner. An advisory transaction lock serializes binding with first-time identity resolution.
The application role cannot read aliases or execute the binding function.

The legacy token is retired (its verification passed: the CLI's Clerk API key reaches the same vault). Disabling
`clerk-auth` is a rollback switch that makes the API refuse every request; it preserves all data.

## Verification

- Unit tests cover token classes, scopes, account/session revocation, email verification and origin checks.
- Integration tests use RSA-signed JWTs, the real Clerk SDK, migrated PGlite, the application role, real handlers
  and RLS: two users, forged/expired tokens, bearer and cookie sessions, CSRF rejection and stable ownership.
- Database tests prove operator-only binding, repeatability, no cross-user access and refusal to merge owners.
- An end-user production login must still be completed by the account holder; local fixtures do not prove that flow.

## Official references

- [Clerk with Neon](https://clerk.com/docs/guides/development/integrations/databases/neon)
- [Clerk request authentication](https://clerk.com/docs/reference/backend/authenticate-request)
- [Clerk token/auth objects](https://clerk.com/docs/reference/backend/types/auth-object)
- [When to synchronize user data](https://clerk.com/docs/guides/development/webhooks/syncing)
- [Neon with Drizzle](https://neon.com/docs/guides/drizzle)
- [Neon Drizzle migrations](https://neon.com/docs/guides/drizzle-migrations)

See [migrations](migrations.md) for automatic merge/deployment sequencing.
