# Contributing

Thanks for taking the time to improve Headjack.

## How this repository is built

Most of the files here are exported from the maintainer's own repository, where the code is developed. Each export
overwrites those files, so a change made to them directly on GitHub would be lost or would conflict with the next export.

The repository's own files are the ones the export never touches: `README.md`, `package.json`, `SECURITY.md`,
`CONTRIBUTING.md`, `.gitignore` and the workflows under `.github/`.

## Pull requests

Pull requests that change files exported from the maintainer's repository are not merged on GitHub. If the maintainer
accepts the change, they apply it to the source repository as a patch, publish the next export, and close the pull request
with a link to the commit that carries it.

Pull requests that change only the repository's own files (README.md, package.json, SECURITY.md, CONTRIBUTING.md,
.gitignore, workflows) may be merged here.

The `version` in `.claude-plugin/plugin.json` is set by the export. A pull request must not change it; the CI check fails
if it does.

## Before you open a pull request

- For anything larger than a small fix, open an issue first so the direction can be agreed.
- Run the tests with `npm test`. There is nothing to install: the suite uses only Node.js, and it is verified on Node 24.
- Keep a change focused on one thing, and add or update a test with it.
- Do not include credentials, tokens or other people's data in a pull request, an issue or a log.

## Reporting a vulnerability

Do not use issues or pull requests for a vulnerability. Follow [SECURITY.md](SECURITY.md).
