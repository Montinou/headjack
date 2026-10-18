# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository
(`Montinou/headjack`): open the **Security** tab, choose **Report a vulnerability**, and describe the issue. Do not open a
public issue, pull request or discussion for a suspected vulnerability.

A useful report includes:

- the affected component (web app, REST API, MCP server, `headjack` CLI including `suggest`, `enrich` and `pull`, the
  Claude Code plugin hooks, local SQLite vault, launcher, skill, database policies or build scripts) and the version or
  commit;
- steps to reproduce, or a proof of concept;
- the impact you expect, for example reading another owner's skills, bypassing authentication, reading files outside the
  directories the CLI is meant to touch, installing content that was not reviewed, or leaking a stored credential.

Never include real credentials, tokens or other people's data in a report. Use placeholder values.

## Scope

In scope: this repository's code, including the row-level security policies in `drizzle/`, the authentication and
identity code in `lib/`, the MCP server, the `headjack` CLI and the Claude Code plugin hooks in `plugin-hooks/`. For the
CLI that covers how it stores credentials, scans sources, links skills into an agent harness's skills directory, writes
the files under `<state dir>/suggest/`, and sends prompt or skill text to a server (`suggest`, `enrich`, `pull`).

Out of scope: any instance other than the maintainers' own, and vulnerabilities in third-party services (Vercel, Neon,
Clerk, the AI Gateway), in dependencies or in Node.js itself, which should go to their maintainers. A third-party issue
that this code makes exploitable is in scope.

## What suggestions and enrichment send

With `suggest.hosted` false (the default, whatever `HEADJACK_MODE` says), suggestions make no network call. These
features send text off the machine, each opt-in. Hosted mode itself also sends search queries (in the URL), skill
content on `import` and `review`, and install records on `add` to the server.

- **Hosted suggestions** (`suggest.hosted` is true in `config.json`). Each prompt that reaches the search, from the
  plugin hook or from `headjack suggest`, is cleaned first: `<pasted_content>` blocks and fenced code blocks are removed and the
  rest is cut to at most 300 characters (`prepareQuery` in `lib/suggest.mjs`). That text goes to the hosted server in the body
  of a `POST /api/search`, never in the URL. The server ranks with it, which includes sending it to its embeddings
  provider through the AI Gateway. Inline code, indented code and anything else left in those 300 characters are sent as
  typed: prompts get no secret scan. The only record it keeps of a `suggest` search is an HMAC of the text, the
  returned slugs, the session id, the variant and the time (`lib/handlers.mjs`), and only when
  `SEARCH_EVENTS_HMAC_KEY` is set and the session id is valid. `headjack suggest --calibrate --mode
  hosted` sends the prompts of the eval set the same way.
- **The warmup hook**, in hosted mode, sends a fixed string (`warm up the headjack skill search`), never a prompt
  (`cli/hook.mjs`).
- **`headjack enrich`** (and `import` while it is on) is off unless `enrich.enabled` is true and an AI Gateway key is
  present. It sends each skill's name, description and first 6,000 body characters to the Vercel AI Gateway, only after
  a secret scan of exactly that text; a skill that trips the scan is skipped (`cli/enrich-local.mjs`).

On disk, `<state dir>/suggest/log.jsonl` and `<state dir>/suggest/sessions/` hold slugs, outcomes and timings, never
prompt text. A prompt is stored locally only in `<state dir>/suggest/cases.jsonl`, and only when you run
`headjack suggest --save`.

## Supported versions

Only the latest commit on the default branch receives security fixes.
