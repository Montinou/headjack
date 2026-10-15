# Headjack capability contract

Contract version: 2

An agent workflow can use Headjack as its capability layer: a task names the skills it needs, and the implementer finds
them, installs them for the task, and releases only the ones it added. This document lists the part of the `headjack`
CLI that such a consumer may depend on. Anything not listed here can change without notice. A change to anything listed
here needs a new contract version.

Version 2 renames the CLI to `headjack`, its environment inputs to `HEADJACK_*` and the session header to
`x-headjack-session`. The commands, JSON shapes and exit codes are those of version 1.

Every bullet is pinned by a test: the shapes, exit codes and environment inputs in `test/unit/contract.test.mjs`; the
`add --source` values, an invalid `--purpose` or `--source` (exit 2) and the dropped invalid session id in
`test/unit/entrypoint.test.mjs`; `remove --from` in `test/unit/install.test.mjs`.

## Surface

- **`search "<q>" -k N --json [--purpose <p>]`**: prints a JSON array of results. Each result carries the vault row
  fields (`slug`, `name`, `description`, `kind`, `plugin_slug`, `tags`, `update_available`), the fused `score`, and
  `active` (true when the skill, its plugin or an alternative install is active locally or enabled in Claude Code).
  It also carries the per-result search signals:
  - `fts_rank`: 1-based position in the full-text list, or `null` when absent from it.
  - `vector_rank`: 1-based position in the vector list, or `null` when absent from it.
  - `similarity`: cosine similarity of the best chunk, or `null` when absent from the vector list.
  - `matched`: `fts`, `vector` or `both`.
  - `variant`: `rrf-english` or `rrf-bilingual`, the path that answered.

  `<p>` is one of `suggest|plan|manual|eval|warmup` (default `manual`); an invalid value exits 2.
- **`add <slug> --to <harness> [--session] [--source <s>]`**: exits 0 on success, and also when the slug is already
  installed. `<s>` is one of `suggest|plan|manual` (default `manual`); an invalid value exits 2.
- **`list --json`**: prints the raw state entries.
  - Plugin skills are keyed by their plugin key. A consumer maps a vault slug `<plugin>@<marketplace>:<skill>` to the
    entry `<plugin>@<marketplace>`.
  - A skill entry has `slug`, `kind`, `sha256` and `targets`.
  - A plugin entry has `slug`, `kind` and `targets`, and no `sha256`.
  - `session: true` and `addedAt` appear only on session entries.
- **`remove <slug> [--from <h>] [--if-session]`** and **`cleanup`**. With `--if-session`, a session entry is removed
  exactly like plain `remove`. A plugin-skill slug resolves to its plugin's entry. A permanent or inactive entry is
  left alone with a one-line reason, and the command exits 0. `cleanup` removes only session entries.
- **Exit codes**:
  - 0: success or no-op.
  - 2: user errors, and API errors other than transient ones.
  - 3: network failure or HTTP 5xx.
  - 1: unexpected errors, and commands that report failed items.
- **Environment inputs**:
  - `HEADJACK_URL`: the vault.
  - `HEADJACK_TOKEN`: the bearer token.
  - `CLAUDE_CODE_SESSION_ID`: sent as `x-headjack-session` when it matches `^[A-Za-z0-9-]{1,64}$`.
  - `HEADJACK_PURPOSE`: the default for `--purpose`.
- **Events are advisory**: a failed event call never changes an exit code.
