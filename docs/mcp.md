# The Headjack MCP server

`headjack mcp` serves the Model Context Protocol over standard input and output, so an
agent can search your skill vault, read a skill and get the command that installs it, without a shell. It has no
dependencies, and it changes nothing in the catalog: the four tools only read. (The client may refresh a saved login, and
local mode opens, or creates, the vault file.) It works on whatever the CLI is configured for:

- the **local vault** (a SQLite file in the state directory, no server, no account) when `HEADJACK_URL` is not set; or
- a **hosted server** you have access to when it is: any server that meets [the server contract](server-contract.md).

Everything a tool returns about a skill is untrusted text written by whoever published the skill. The server says so in its
`initialize` answer and in every tool description, and a client should treat it as data: never as an instruction.

## Registering the server

**Claude Code.** The plugin declares the server inline in `.claude-plugin/plugin.json`, so installing or loading the plugin
is all there is to do. The declaration is:

```json
{
  "mcpServers": {
    "headjack": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/headjack",
      "args": ["mcp"]
    }
  }
}
```

Claude Code starts it with your environment, so `HEADJACK_URL` and the other variables below reach it.

**Any other MCP client.** Register a stdio server whose command is the launcher of a clone of this repository and whose
argument is `mcp`. Many clients start a server with a reduced environment, so name the variables it needs in an `env` block.
This is the usual JSON shape (the file and the key names differ between clients):

```json
{
  "mcpServers": {
    "headjack": {
      "command": "/path/to/headjack/bin/headjack",
      "args": ["mcp"],
      "env": {
        "HEADJACK_URL": "https://headjack.example.invalid"
      }
    }
  }
}
```

Leave `env` out, or leave `HEADJACK_URL` out of it, for the local vault. The launcher runs `node`, so `node` must be on the
`PATH` the client gives the server (a client with a reduced environment may need a `PATH` entry in `env` as well), and the
server finds its state directory through `HOME`, or through `HEADJACK_HOME` when that is set.

**Danger of a dropped variable.** A client that drops `HEADJACK_URL` silently serves the local vault, which may be empty.
The `instructions` of the `initialize` answer therefore state the mode in one sentence: `local mode`, or `hosted mode` with
the server's origin (never a credential, a path or a query). A client that shows `instructions` shows what it is talking to.

## Pointing it at a hosted server

1. Set `HEADJACK_URL` to the server's address (`https`, or `http` on a loopback host, no credentials, query or fragment).
2. Give the server a credential: run `headjack login` once in a terminal, or put an API key in `HEADJACK_TOKEN` (see the
   README for both).
3. Start (or restart) the client.

The server reads the credential on every call, not at start-up. A missing credential does not stop the process: it still
answers `initialize`, and a tool call answers `unauthenticated`; the tool descriptions advise running `headjack login`.
Running it afterwards takes effect on the next call, with no restart.

The tools use four routes of the contract and nothing else: `GET /api/search` (`search_skills`), `GET /api/skills`
(`list_my_skills`), `GET /api/skills/{slug}` (`get_skill` and `install_command`) and `GET /api/skills/{slug}/download`
(`get_skill`).

| Variable | Meaning |
|---|---|
| `HEADJACK_URL` | the hosted server; unset means the local vault |
| `HEADJACK_MODE` | `local` or `remote`; overrides the choice `HEADJACK_URL` makes |
| `HEADJACK_TOKEN` | an API key for a hosted server; wins over a saved login |
| `HEADJACK_HOME` | the state directory (default `~/.headjack`) |
| `HEADJACK_MCP_TIMEOUT_MS` | how long a hosted request may take, in milliseconds (default 30000, that is 30 s); a request that takes longer ends as `unavailable` |

A bad `HEADJACK_MODE` or `HEADJACK_URL` does not stop the process before `initialize`: the generic `instructions` are sent,
and the first tool call reports the problem as a code (see the error codes: a bad `HEADJACK_URL` is `unauthenticated`, a bad
`HEADJACK_MODE` is `unavailable`).

## The protocol

- **Transport.** stdio, newline-delimited JSON-RPC 2.0: one message per line, UTF-8, `\n` (or `\r\n`) after each, no
  embedded newline. Empty lines are ignored.
- **Versions.** `initialize` answers with the client's `protocolVersion` when it is `2024-11-05`, `2025-03-26` or
  `2025-06-18`, and with `2025-06-18` for any other value. The capabilities are `{ "tools": {} }`; `serverInfo` is
  `{ "name": "headjack", "version": <the plugin version> }`.
- **Methods.** `initialize`, `ping` (empty result), `tools/list` and `tools/call`. A notification (a message with no `id`),
  `notifications/initialized` included, is never answered. Any other request is answered with the JSON-RPC error `-32601`.
- **Errors in the protocol.** `-32700` (with a `null` id) for text that is not JSON; `-32600` for a message that is not an
  object, has no string `method`, has an `id` that is not a string, a number or null, or is a JSON array. **JSON-RPC batch
  requests are not supported**: an array is `-32600`. A line longer than 1 MiB is answered with `-32600` and the process keeps running.
- **Order.** Requests are served one at a time, in the order they arrived. When the input closes, the request in flight
  finishes, its answer is flushed, and the process exits with status 0.
- **Output.** stdout carries protocol messages only. The server's own diagnostics go to stderr as fixed one-line messages with
  no path, token or stack trace.

## The tools

A tool result is `{ "content": [ { "type": "text", "text": "<JSON>" } ], "isError": false }`: `text` is a JSON document, the
output below. A failure of any kind (invalid input included) is a result with `"isError": true` whose text is
`{ "error": { "code": "<code>" } }`, never a JSON-RPC error, so the model can correct itself. Input schemas are JSON Schema
with `"additionalProperties": false`; `tools/list` returns them.

### `search_skills`

Searches the catalog. It installs nothing.

- Input: `query` (string, 1 to 300 characters; write it in English), `k` (integer, 1 to 10, default 5), `tags` (array of at
  most 8 strings of 1 to 64 characters; a result must carry all of them). A tag that holds a comma or only blanks is `invalid_input`: the
  server splits a tag filter on commas, so it would filter nothing.
- Output: `{ "results": [ { "slug", "kind", "description", "tags", "update_available" } ] }`, best first. The search is a
  manual one (`x-headjack-purpose: manual`), so a hosted server does not log an exposure.

### `get_skill`

Reads one skill. Input: `slug` (string, 1 to 256 characters; `.` and `..` are `invalid_input`, as they would leave the route).

The output is the full metadata row of the skill as the server returns it from `GET /api/skills/{slug}`, plus three fields
about its text:

| Field | Meaning |
|---|---|
| `slug`, `name`, `description` | identity and purpose |
| `kind` | `skill` or `plugin` |
| `plugin_slug` | the plugin a skill ships in, or null |
| `tags` | the tags |
| `quality` | the audit scores, or null |
| `source_path`, `source_kind`, `source_url`, `default_ref` | where the skill came from. `source_url` is returned without the `user:password@` part of a URL it can parse, and nothing more: a raw `/`, `?` or `#` in the password, a backslash in the password (`scheme://user:pw\@host/x` comes back unchanged, because the parser rejects it), a token-only username that holds a backslash and a bare scheme-less `user:pw@host` are left as they are. A server must not store credentials there |
| `commit_sha`, `latest_commit` | the reviewed upstream commit and the newest one seen |
| `sha256` | the content hash of the current version |
| `size` | the archive size in bytes |
| `reviewed_at` | when the current version was reviewed |
| `review_notes` | the reviewer's notes |
| `scan_flags` | what the review scan found: a list of `{ rule, severity, file, line }`, with `match` (up to 120 characters) for a text rule |
| `update_available` | true when upstream moved |
| `skill_md` | the start of the root `SKILL.md`, or null |
| `truncated` | true when `skill_md` was cut |
| `content_status` | `available` when `skill_md` holds the text, else `unavailable` |

How the text is read:

- `content_status` is `available` when the root `SKILL.md` of the current version was read, and `unavailable` otherwise. In
  that case `skill_md` is null and `truncated` false, and the metadata is still returned.
- A **plugin** (`kind` `plugin`, or a skill with a `plugin_slug`) has no archive and is not downloaded: `unavailable`.
- Otherwise the archive comes from `GET /api/skills/{slug}/download`. Its `x-skill-sha256` header must equal the `sha256` of
  the metadata, or the answer is the error `content_unavailable`: the metadata and the text never come from different
  versions. **A server that does not send that header makes `get_skill` return `content_unavailable`.** A download that
  answers 404 or 409 (no approved version, or a kind that is never downloaded) gives `unavailable` with the metadata.
- The archive is unpacked with an expansion cap of 16 MiB and a download over 16 MiB is refused (`content_unavailable`): the client reads no more of it once its declared length, or the bytes received, pass 16 MiB. A
  corrupt archive is `content_unavailable` too. Only the `SKILL.md` at the archive root counts: a `SKILL.md` in a subdirectory is not read, and an archive without a root one gives `unavailable`.
- The text is decoded as strict UTF-8 (invalid bytes: `content_unavailable`) and cut at 8192 bytes, backing off to the start
  of a character, with `truncated` true when it was cut.
- An unknown slug is `not_found`.

### `list_my_skills`

Lists the catalog, 50 skills a page.

- Input: `kind` (`skill` or `plugin`), `tag` (one tag, with no comma), `cursor` (string); all optional.
- Output: `{ "skills": [ { "slug", "name", "kind", "tags", "update_available", "description" } ], "next_cursor": "50" }`. The
  entries come from `GET /api/skills` (`kind`, `tag`, `limit` 50 and `offset` of the contract). `description` is cut at 100
  characters on a word boundary and marked with an ellipsis, and `tags` at 3; use `get_skill` for the whole record.
- **Cursors are opaque.** Pass `next_cursor` back as `cursor` for the next page; `next_cursor` is null on the last page. A
  client must not build or parse a cursor (today it happens to be a number, an offset). The server checks only that a
  `cursor` is a canonical number (digits, no leading zero, at most nine of them); anything else is `invalid_input`.

### `install_command`

Returns the shell command that installs a skill. It executes nothing and does not promise that the install works.

- Input: `slug` (string, 1 to 256 characters; `.` and `..` are `invalid_input`), `harness` (a harness id such as `claude`, `codex`, `grok`, `gemini` or
  `cursor`; any other value is `invalid_input`).
- Output: `{ "command": "headjack add --to 'codex' --session -- 'demo'", "reload_plugins": false }`. Every value is
  single-quoted for a POSIX shell. A plugin can be installed for `claude` only (any other harness is `unsupported_harness`)
  and needs a plugin reload: `reload_plugins` is then true. An unknown slug is `not_found`.

## Error codes

| Code | When |
|---|---|
| `invalid_input` | the arguments fail the input schema, the cursor is not a canonical number, a tag holds a comma or only blanks, the slug is `.` or `..`, the tool or the harness is unknown |
| `bad_request` | the server answered 400 |
| `unauthenticated` | the server answered 401, or, in hosted mode, the client could not be opened for a reason it reports in words: no credential, a credential file it cannot use, a refresh that failed, a bad `HEADJACK_URL`. The tool descriptions advise running `headjack login`, which fixes the first three; for a bad `HEADJACK_URL`, check the variable |
| `forbidden` | the server answered 403 |
| `not_found` | the server answered 404, or the skill does not exist |
| `conflict` | the server answered 409 |
| `rate_limited` | the server answered 429 |
| `unavailable` | no connection, a connection cut while the answer was being read, the timeout, a JSON answer from a hosted server over 8 MiB, a 5xx answer, a busy local vault, a bad `HEADJACK_MODE`, or, in local mode, a state directory that cannot be used. (In hosted mode such a client problem is `unauthenticated`, see above.) |
| `vault_damaged` | the local vault file is damaged (it is left untouched) |
| `unsupported_harness` | a plugin asked for a harness other than `claude` |
| `content_unavailable` | the text of a skill cannot be paired with its metadata or cannot be read (see `get_skill`) |
| `internal` | anything else |

A code is all a failure carries: no message of the server, no path and no credential is ever copied into the answer.
