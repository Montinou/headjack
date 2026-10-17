# The server contract

This document states what a Headjack server must do for the `headjack` command line tool and for `headjack mcp` to work
against it. It describes the requests the client sends and the answers it relies on, so that anyone can build a compatible
server. It says nothing about how a server stores its data, how it authenticates its users or where it runs.

The client is the code in this repository; if this document and the code disagree, the code is right and the document has a
bug. Every route the client calls is checked against the routes written here, as exact `METHOD path` pairs.

The same contract is what local mode implements in process over a SQLite file, so the CLI behaves the same in both modes.

## Conventions

- **Base URL.** `HEADJACK_URL`, for example `https://headjack.example.invalid`: `https`, or `http` on a loopback host; no
  credentials, query or fragment. Every route below is a path appended to it. A path prefix in `HEADJACK_URL` is
  kept in front of every route.
- **Authentication.** Every `/api/` request carries `Authorization: Bearer <token>`. The token is either an API key the
  operator issued (the client reads it from `HEADJACK_TOKEN` or from a file in its state directory) or an OAuth access token
  (see the optional login at the end). **A server that accepts a bearer API key is complete**: the OAuth login is optional.
  A missing or invalid token is `401`.
- **Scopes.** A server may require a read permission for the `GET` routes and a write permission for `POST /api/skills`.
  The names the client uses when it asks for them are `skills:read` and `skills:write`. A token without the permission an
  operation needs is `403`.
- **Content type.** Answers are JSON (`content-type: application/json`), except the download, which is `application/gzip`,
  and `POST /api/events/install`, which answers `204` with no body. A request body the client sends is JSON, except the
  multipart form of `POST /api/skills` and the `application/x-www-form-urlencoded` bodies of the token and revocation
  requests of the optional login (at the end of this document).
- **Errors.** Any status of 400 or more carries this body, and the client reads only these two fields:

  ```json
  { "error": { "code": "not_found", "message": "skill demo not found" } }
  ```

  `code` is a short machine word and `message` is one line for a person. A body that is not that shape is tolerated: the
  client then reports `HTTP <status>`. The codes the handlers in `lib/handlers.mjs` (what local mode runs) answer with are `bad_request` (400), `hash_mismatch` (400),
  `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `internal` (500) and `unavailable` (503).
  The client branches on the status, never on the text of `message`.
- **Slugs.** A slug matches `^[A-Za-z0-9._@:-]{1,200}$`. It goes into the path percent-encoded; a slug that does not match
  is `400 bad_request`.
- **Tags.** A tag is lowercase kebab-case (`[a-z0-9]+(-[a-z0-9]+)*`, at most 50 characters); a skill carries at most 8.
- **Timestamps** are ISO-8601 in UTC, for example `2026-01-31T12:00:00.000Z`.
- **Optional request headers.** The client sends two headers that a server may ignore:
  - `x-headjack-session`: an opaque id of the agent session (letters, digits and `-`, at most 64 characters), sent on every
    request when the client knows one. A server may use it to group the requests of a session for measurement. It is never
    an authorization input, and a value that does not match is to be treated as absent.
  - `x-headjack-purpose`: sent by `GET /api/search` only, one of `suggest`, `plan`, `manual`, `eval` and `warmup`. The CLI
    sends `manual` unless the caller passes `--purpose` or sets `HEADJACK_PURPOSE`. A server that records searches should
    record only `suggest`; any other value, or none, is `manual`. `headjack mcp` always sends `manual`.

## The skill record

Several routes return a skill record. Its fields, as the handlers in `lib/handlers.mjs` send them:

| Field | Type | Meaning |
|---|---|---|
| `slug` | string | the identifier, unique in the catalog |
| `name` | string | display name |
| `description` | string | what the skill is for |
| `kind` | `"skill"` or `"plugin"` | a plugin is enabled through the harness's settings and has no archive |
| `plugin_slug` | string or null | for a skill that ships inside a plugin, that plugin's slug |
| `tags` | string[] | normalized tags |
| `quality` | object or null | audit scores (`reuse`, `trigger`, `content`, `health`, each 0 to 3, plus `verdict` and `audited_at`); null when the skill was never audited. The client treats it as opaque |
| `source_path` | string or null | path of the skill inside its source repository |
| `source_kind` | `"github"`, `"git"`, `"marketplace"`, `"local"` or null | where it came from |
| `source_url` | string or null | the source repository's URL. A server must not store credentials in it. `headjack mcp` removes the `user:password@` part of a URL it can parse before it shows the value, and nothing more: it leaves a raw `/`, `?` or `#` in the password, a backslash in the password (`scheme://user:pw\@host/x` comes back unchanged, because the parser rejects it), a token-only username that holds a backslash, and a bare scheme-less `user:pw@host` as they are |
| `default_ref` | string or null | the ref the source is tracked on |
| `commit_sha` | string or null | the source commit of the current version |
| `sha256` | string or null | the content hash of the current version (see below); null when the skill has no current version |
| `size` | integer or null | byte length of the current version's archive |
| `reviewed_at` | string or null | when the current version was reviewed |
| `review_notes` | string or null | the reviewer's notes; an import that was accepted without review says `grandfathered:` first |
| `scan_flags` | object[] | what the reviewer's scan found in the current version: each is `{ "rule", "severity", "file", "line" }` with `severity` `"high"` or `"low"`, and `match` (up to 120 characters) for text rules; `[]` when nothing was found |
| `update_available` | boolean | whether the upstream source has a newer commit than the reviewed one |
| `latest_commit` | string or null | the newest upstream commit the server has seen |

**The content hash.** `sha256` is 64 lowercase hex characters computed over the version's files, in this exact way: sort the
files by path (in UTF-16 code-unit order, the order of a JavaScript string comparison, which is byte order for ASCII paths);
for each file take the SHA-256 of its content as hex; feed the hash of the whole version the text
`<path>\0<mode>\0<content hash>\n` (encoded as UTF-8), where `<mode>` is the file mode in octal padded to four digits (`0644`, or `0755`
for an executable file); the digest of that, as hex, is `sha256`. The client recomputes it on install and refuses to install
a file set whose hash differs from the record's `sha256`.

## Routes

### GET /api/search

Ranked search over the catalog. Query parameters:

- `q` (required, non-empty after trimming): the query text.
- `k` (optional, default 8): how many results; an integer from 1 to 25, else `400`.
- `kind` (optional): `skill` or `plugin`.
- `tag` (optional, repeatable, or comma-separated): every tag listed must be carried by a result.

Answer `200`: `{ "results": [ ... ] }`, best first. Each result has `slug`, `name`, `description`, `kind`, `plugin_slug`,
`tags` and `update_available` as in the skill record, a `review` status (`unreviewed` when the current version's review
notes start with `grandfathered:`, `plugin:` or `plugin skill:`, else `approved`; the notes themselves are not part of a
search result), and the ranking diagnostics `score`, `fts_rank`, `vector_rank`,
`similarity`, `matched` and `variant`. A result that stands for several installs of one plugin lists the other slugs in
`alternatives`. The skill's `quality` is not part of a search result. The client uses `slug`, `name`, `description`, `kind`,
`tags`, `update_available` and `alternatives`; the diagnostics are for evaluation and may be omitted.

How a server ranks is its own business (`lib/search.mjs`, which local mode runs, fuses full-text and vector search).

### GET /api/skills

The catalog, one page at a time, ordered by `name` and then `slug`. Query parameters:

- `kind` (optional): `skill` or `plugin`.
- `tag` (optional, repeatable, or comma-separated): every tag listed must be carried by a result.
- `limit` (optional, default 24): an integer from 1 to 100. The client sends 50.
- `offset` (optional, default 0): a non-negative integer, how many skills to skip.

Answer `200`: `{ "skills": [ ... ], "total": 120, "limit": 50, "offset": 0 }`. `total` counts the skills that match
`kind` and `tag` before paging, so a client pages until `offset + skills.length >= total`. Each entry has `slug`, `name`,
`description`, `kind`, `plugin_slug`, `tags`, `quality` and `update_available` as in the skill record, and
`has_approved_version`, a boolean that is false for a skill that has no approved version. This route lists skills that have
no approved version too. A bad `kind`, `limit`, `offset` or `tag` is `400`. This is the route behind the `list_my_skills`
tool of `headjack mcp`.

### GET /api/skills/{slug}

Answer `200`: `{ "skill": { ... } }` with the skill record above. An unknown slug is `404 not_found`; the client reads that as
"no such skill". The record describes the skill's current approved version, so a skill whose versions were all rejected has
null version fields.

### GET /api/skills/{slug}/download

The archive of the current version of a skill. Answer `200` with the body `application/gzip` and the response header
`x-skill-sha256`, whose value is the version's `sha256`, exactly as the skill record shows it.

**`headjack mcp` depends on that header.** `get_skill` reads the record and the archive separately, and returns the text of
`SKILL.md` only when the header equals the record's `sha256`, so that the metadata and the text never come from different
versions. A download without the header, or with a different value, makes `get_skill` answer `content_unavailable`. The
`install` command makes the same check and refuses to install on a mismatch.

The archive is a gzip-compressed ustar tar of regular files only: paths are relative, use `/`, contain no empty, `.` or `..`
segment and no backslash; each file has mode `0644` or `0755`. A skill's `SKILL.md` sits at the archive root.

Other answers: `404 not_found` for an unknown slug, or for a skill that has no approved version; `409 conflict` for a plugin
or a plugin's skill, which is enabled through settings and never downloaded. The client reads both as "there is no archive to
read".

### GET /api/skills/{slug}/versions

Answer `200`: `{ "versions": [ ... ] }`, every version ever reviewed, newest first. Each has `id`, `commit_sha`, `sha256`,
`size`, `status` (`approved` or `rejected`), `reviewed_at`, `review_notes`, `scan_flags` and `current` (true for the version
the skill record describes). `404 not_found` for an unknown slug.

### GET /api/skills/{slug}/reviews

Answer `200`: `{ "reviews": [ ... ] }`, the review history, newest first. Each has `commit_sha`, `status`, `reviewed_at`,
`review_notes`, `sha256` and `current`. `404 not_found` for an unknown slug.

### POST /api/skills

Publishes a reviewed version. The body is `multipart/form-data` with two parts:

- `manifest`: a JSON text with these fields. Required: `slug`, `name` and `description` (non-empty), `kind`, `status`
  (`approved` or `rejected`), `sha256` and `chunks` (an array of strings, the text the server searches; an approved version
  needs 1 to 40 of them). Optional: `plugin_slug`, `tags` (strings), `scan_flags` (an array), `review_notes`, `commit_sha`,
  `source_path` and `source`, an object whose `kind` is `github`, `git`, `marketplace` or `local`, with `url` and
  `default_ref` for the remote kinds.
- `tarball`: the archive described under the download route, sent as a file part named `<slug>.tgz`. It is required for an
  approved standalone skill (`kind` `skill`, no `plugin_slug`), and absent for a plugin, a plugin's skill and a rejected
  version. The client keeps it under 4 MiB.

The server recomputes the content hash of the archive and refuses a manifest whose `sha256` differs with `400 hash_mismatch`.
Answer `201` with a JSON body that holds the ids of what was written (the handlers in `lib/handlers.mjs` send `skillId` and `versionId`;
the client ignores them). Publishing a `slug` and `sha256` that already exist is `409 conflict`, which the client reports as
"already there". An approved version becomes the skill's current version; a rejected one is recorded and changes nothing the
skill record shows except the review history.

### GET /api/updates

Skills whose upstream source moved since they were reviewed. Answer `200`: `{ "updates": [ ... ] }`. Each entry has `slug`,
`name`, `current_commit`, `reviewed_commit`, `latest_commit`, `checked_at`, `source_url` and `source_path`. With the query
`grandfathered=1` the list is instead the skills that were imported without review, each `{ "slug", "name", "reviewed_at" }`.

The client also uses this route to ask whether a token works (`headjack whoami`, and the last check of `headjack login`):
`200` means accepted, `401` and `403` mean refused.

### POST /api/events/install

Tells the server that the client installed a skill. The body is JSON: `{ "slug": "demo", "kind": "skill", "source": "manual" }`
with `slug` a valid slug, `kind` `skill` or `plugin`, and `source` one of `suggest`, `plan` and `manual`. Answer `204` with no
body. The client sends it after a successful install, waits at most 3 seconds, and ignores any failure, so a server may
accept it and record nothing.

## What a minimal server implements

For a client to search, read, install and list, a server needs `GET /api/search`, `GET /api/skills`,
`GET /api/skills/{slug}` and `GET /api/skills/{slug}/download` with its `x-skill-sha256` header, bearer authentication, and
the error body. `headjack mcp` needs exactly those four routes. The other routes serve `headjack review`, `headjack import`
and `headjack updates`; a server without them makes those commands fail with the server's status, and nothing else.

## Optional: OAuth login

`headjack login` signs in through the browser, with OAuth 2.0 authorization code flow and PKCE. A server that only accepts API
keys skips this section: `headjack login` then reports that the server has not enabled CLI login, and the user supplies a
token through `HEADJACK_TOKEN`. The flow talks to two parties: the server (the resource) and an authorization server. All
their URLs must be `https`, or `http` on a loopback host.

### GET /.well-known/oauth-protected-resource/api

On the server, appended to `HEADJACK_URL` (`<HEADJACK_URL>/.well-known/oauth-protected-resource/api`). The answer is a JSON object with:

- `resource`: the server's API URL, which must equal `<HEADJACK_URL>/api` once case, a default port and a trailing slash are
  ignored;
- `authorization_servers`: an array with exactly one string, the issuer URL of the authorization server;
- `headjack_cli_client_id`: the OAuth client id the CLI uses.

A `404` means CLI login is not enabled on this server. A redirect is an error: the client does not follow it.

### GET /.well-known/oauth-authorization-server

On the issuer, appended to its URL. A JSON object with `issuer` (exactly the issuer URL that was named above),
`code_challenge_methods_supported` (it must include `S256`), `authorization_endpoint`, `token_endpoint` and
`revocation_endpoint`.

### GET /.well-known/openid-configuration

On the issuer as well. A JSON object with `issuer` (the same value) and `userinfo_endpoint`. The client fetches both
documents together and needs both.

### The login

1. The CLI starts a listener on `127.0.0.1` on the first free port of 53437, 53438 and 53439, and sends the browser to the
   `authorization_endpoint` with `response_type=code`, `client_id`, `redirect_uri=http://127.0.0.1:<port>/callback`,
   `scope=openid email offline_access skills:read skills:write`, `resource` (the API URL), `code_challenge`,
   `code_challenge_method=S256` and `state`. The client must allow those three redirect URIs.
2. The browser comes back to `/callback` with `code` and `state`. A callback may carry `iss`, which must equal the issuer, and
   `error`, which ends the login.
3. The CLI posts `application/x-www-form-urlencoded` to the `token_endpoint` with `grant_type=authorization_code`, `code`,
   `code_verifier`, `client_id`, `redirect_uri` and `resource`. The answer is JSON with `access_token`, `refresh_token` and
   `expires_in` (seconds, positive). A redirect from the token endpoint is an error.
4. The CLI calls `GET` on the `userinfo_endpoint` with `Authorization: Bearer <access token>`; the answer must hold `email`.
5. The CLI calls `GET /api/updates` with the new access token and saves the login only if the answer is `200`.

### Refresh and logout

The access token is used as the bearer for `/api/` requests. When it is close to its end, or a request is answered `401`, the
client posts to the `token_endpoint` with `grant_type=refresh_token`, `refresh_token`, `client_id` and `resource`, takes the
new `access_token` and `expires_in`, and keeps the old refresh token when the answer has no `refresh_token`. A refusal (a 4xx
with an OAuth `error` word) ends the login: the user must run `headjack login` again.

`headjack logout` posts `application/x-www-form-urlencoded` to the `revocation_endpoint` with `token`, `token_type_hint`
(`refresh_token` or `access_token`) and `client_id`, for both tokens. It is best effort: a failure never keeps the local file.
