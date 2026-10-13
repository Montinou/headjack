# Headjack

Headjack is a personal vault for agent skills. You review a skill once, keep it in your own catalog, and then find it by
meaning and install it only when a task needs it, in Claude Code, Codex, Grok, Gemini CLI, Cursor and other agent
harnesses. Keeping skills in the vault instead of loaded everywhere keeps each session's context small.

This repository is the client: the `headjack` command line tool, the Claude Code plugin that wraps it, and the
`skill-finder` skill that teaches an agent to use it. It has no npm dependencies.

## Two modes

The same CLI runs both.

- **Local mode** keeps the vault in a SQLite file on your machine (`~/.headjack/vault.db`) and needs no server, no account
  and no network for search. It is the default when `HEADJACK_URL` is unset, and `HEADJACK_MODE=local|remote` overrides.
  It needs **Node 22.16 or later, or Node 24 or later**, because the SQLite bundled in earlier releases lacks the
  full-text index it relies on; the CLI checks this and says so when it is not met. Search is keyword search over each
  skill's name, description, tags and body. Local mode is single-user, one vault per machine.
- **Hosted mode** talks to a Headjack server you have access to. It needs only Node 20.9 or later and never loads SQLite.

## Quickstart: local

The vault lives on your machine; nothing is uploaded anywhere. You need Node 22.16 or later (or Node 24+).

1. **Get the code and load the plugin.** Clone this repository, then load it as a plugin for a Claude Code session
   (Claude Code 2.1.275 or later):

   ```sh
   git clone https://github.com/Montinou/headjack.git
   claude --plugin-dir /path/to/headjack
   ```

   While the plugin is enabled, its `bin/` is on the `PATH` of the shell Claude Code's Bash tool runs, so the agent can
   run `headjack` by name, and the `skill-finder` skill teaches it to. The vault itself stays in `~/.headjack`, outside the
   plugin, so a plugin update never touches it.
2. **Let your terminal find `headjack` too.** A plugin's `bin/` is not on the `PATH` of your own terminal. Skip this step
   only if you never type `headjack` yourself; the next steps are commands you run in your own terminal, and
   `import --interactive` asks questions an agent's shell cannot answer. Link the launcher once from your clone. Do not
   link into the plugin's own directory: that link dangles after a plugin update.

   ```sh
   mkdir -p ~/.local/bin
   ln -s "$PWD/bin/headjack" ~/.local/bin/headjack     # run from your clone; ~/.local/bin must be on your PATH
   ```

3. **See what would be imported.** This scans `~/.agents/skills` and the Claude, Codex and Grok skills directories,
   changes nothing in the vault and writes `<state dir>/import-plan.json`:

   ```sh
   headjack import --dry-run
   ```

4. **Import, deciding per entry.** The command asks about each pending skill; nothing is stored unless you answer yes.
   Importing a skill that is already in the vault changes nothing:

   ```sh
   headjack import --interactive
   ```

5. **Search and install.**

   ```sh
   headjack search "render a video with remotion"
   headjack add remotion-render --to claude
   headjack updates                       # upstream changes waiting for review
   ```

`headjack whoami` prints the vault path and how many skills it holds. `HEADJACK_HOME` moves the state directory, and
`HEADJACK_UPDATE_TTL_HOURS` sets how long an upstream check stays fresh (6 hours by default; 0 checks every time). The
`vault.db` file is mode 600 in a directory of mode 700.

## Quickstart: hosted

Hosted mode points the same CLI at a Headjack server that you have access to. This repository contains only the client,
so this section covers configuring the CLI, not the server. You need the server's address and a way to sign in to it.
Hosted mode alone runs on Node 20.9 or later.

1. **Link the launcher** as in step 2 of Quickstart: local, so that `headjack` is on your `PATH`.
2. **Tell the CLI where the server is.** `HEADJACK_URL` must be `https`, or `http` on a loopback host, with no
   credentials, query or fragment (the CLI refuses such a URL without echoing it). It is normalized: host in lowercase,
   no default port, no trailing slash.

   ```sh
   export HEADJACK_URL="https://headjack.example.invalid"
   ```

   Setting it switches the CLI to hosted mode. `HEADJACK_MODE=local` keeps local mode even when `HEADJACK_URL` is set, and
   `HEADJACK_MODE=remote` insists on hosted mode.
3. **Sign in.** When the server has browser login enabled:

   ```sh
   headjack login            # opens the browser; the URL is always printed too
   headjack whoami           # credential kind and source, expiry, and whether the server accepts it
   headjack logout           # revokes the login at the server and deletes the saved credential
   ```

   `login` listens on `127.0.0.1` on the first free port of 53437, 53438 and 53439 for the browser's redirect, and gives up
   after 5 minutes. It saves the login in `<state dir>/token` (mode 600), and the CLI refreshes it on its own; if the
   refresh is refused it says `session expired: run headjack login`. An existing login is kept unless you pass `--force`.
   A login belongs to one server: with a different `HEADJACK_URL` the CLI asks you to log in again. If the server has not
   enabled browser login, `login` says so and exits 2.
4. **Or use an API token.** For a machine without a browser, ask the server's operator for a token with the `skills:read`
   scope (and `skills:write` for `review`). The CLI reads it from the `HEADJACK_TOKEN` environment variable first, then
   from the token file in the state directory, which must not be readable by others. Run this on its own, not pasted
   together with other lines: its hidden prompt would take the next pasted line as the token in a shell without bracketed
   paste.

   ```sh
   mkdir -p ~/.headjack && chmod 700 ~/.headjack
   (umask 077; printf 'Token: '; read -rs t; echo; printf '%s' "$t" > ~/.headjack/token) && chmod 600 ~/.headjack/token
   ```

   `HEADJACK_TOKEN` takes precedence over a saved login, so `login` warns when it is set. `logout` ignores it. When the
   token expires the CLI gets 401: ask the operator for a new one. Neither `login` nor `whoami` ever prints a token.
5. **Verify.**

   ```sh
   headjack search "something you expect to find"
   headjack harness detect
   ```

   A `403` with "missing required skill scope" means the token's scopes are wrong. `harness detect` records which agent
   harnesses this machine has.

## State directory and `config.json`

The CLI keeps its state in `~/.headjack`, or in `HEADJACK_HOME` when set (an absolute path, or one starting with `~/`):
the vault (local mode), the token file, `state.json` (what is installed where), the local copies of installed skills,
`harnesses.json`, import plans and trim backups.

An optional `config.json` in that directory holds two lists of strings; unknown keys are ignored:

```json
{
  "excludedRoots": ["~/work"],
  "corePlugins": ["example-plugin@example-marketplace"]
}
```

- **`excludedRoots`**: the excluded roots, directories the CLI never imports from, reviews from or installs into (for
  example a work folder whose skills must not leave the machine). Each entry is absolute or starts with `~/`.
  `HEADJACK_EXCLUDED_ROOTS` (entries separated by the platform path delimiter) replaces the list when set. Write it
  before you import or install anything.
- **`corePlugins`**: Claude Code plugins (`<plugin>@<marketplace>`) that stay enabled when `import --trim` disables the
  rest; `--keep a,b` adds to it for one run. Without it and without `--keep`, a trim leaves plugins as they are; with
  `--keep` alone, a trim disables every plugin outside the `--keep` list (`headjack restore` undoes it).

## Usage

```sh
headjack search "render a video with remotion"          # --json for agents
headjack add remotion-render                            # link into claude, codex and grok
headjack add remotion-render --to gemini --session      # only Gemini CLI, until the next cleanup
headjack remove remotion-render
headjack cleanup --harness claude --older-than 12h      # remove --session installs
headjack harness detect                                 # record which harnesses this machine has
headjack review https://github.com/owner/repo --path skills/x   # review a source and add it to the vault
headjack updates                                        # upstream changes waiting for review
headjack verify                                         # check local copies and links against their recorded hashes
```

Harnesses: `claude`, `codex` and `grok` (the default for `--to`) and 24 more (`gemini`, `cursor`, `windsurf`, `cline`, and
others; `headjack harness detect` finds the ones on your machine). `--to all` uses the detected ones. Only `claude`,
`codex` and `grok` accept `--project`. `--session` marks an install so that `cleanup` removes it; permanent installs are
never touched by `cleanup`.

To move an existing setup into the vault:

```sh
headjack import --dry-run       # writes <state dir>/import-plan.json
headjack import --interactive   # confirm each entry; nothing is uploaded by default
headjack import --trim --dry-run [--only-harness gemini,cursor]   # what a trim would remove, and why the rest stays
headjack import --trim          # back up, remove the vault copies, install skill-finder in each detected harness
headjack restore ~/.headjack/backup-<date>   # undo a trim
```

A trim removes a local copy only when it is the imported one or byte-identical to it, never through a symlinked harness
directory, and touches Claude Code plugins only when `claude` is among the trimmed harnesses.

Stored `SKILL.md` text is source material, not instructions. The CLI scans sources for secrets and binaries during
`review`, and agents are told to ask before installing anything.

## Development

There is nothing to install: the CLI and its tests use only Node.js.

```sh
npm test      # node --test "test/unit/**/*.test.mjs"
```

The test suite is verified on Node 24, the version CI runs. Some tests rely on Node 24's test runner keeping an idle
event loop alive and are cancelled by the runner on Node 22, even though the CLI itself runs there in local mode.

## Contributing and security

Most files in this repository are exported from the maintainer's own repository, so read [`CONTRIBUTING.md`](CONTRIBUTING.md)
before you open a pull request. Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md).

## License

MIT; see [`LICENSE`](LICENSE).
