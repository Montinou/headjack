# Contributing

Thanks for taking the time to improve Headjack.

## Pull requests

Pull requests are welcome and are merged here, on GitHub, after review. The repository is the single source of the code:
the hosted server, the web app, the `headjack` CLI, the local SQLite vault and the plugin all live in it.

- For anything larger than a small fix, open an issue first so the direction can be agreed.
- Keep a change focused on one thing, and add or update a test with it.
- Previews are not deployed for pull requests from forks; the GitHub CI run is the check.
- A pull request that changes `cli/headjack`, any file in the import closure of `cli/headjack.mjs`, `skill-finder/`,
  `plugin-hooks/` or `.claude-plugin/` must raise `version` in `.claude-plugin/plugin.json` above the one on `main`
  (semver), because installed plugins update by version. Other changes leave `version` alone.

## Before you open a pull request

- Install the dependencies with `npm ci` and run the tests with `npm test`. The suite is verified on Node 24.
- Do not include credentials, tokens or other people's data in a pull request, an issue or a log.
- Do not commit instance values (a production domain, an OAuth client id, a Vercel or Neon id, an email address); use
  placeholders such as `headjack.example.invalid`.

## Reporting a vulnerability

Do not use issues or pull requests for a vulnerability. Follow [SECURITY.md](SECURITY.md).
