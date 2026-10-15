# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository
(`Montinou/headjack`): open the **Security** tab, choose **Report a vulnerability**, and describe the issue. Do not open a
public issue, pull request or discussion for a suspected vulnerability.

A useful report includes:

- the affected component (web app, REST API, MCP server, `headjack` CLI, local SQLite vault, launcher, skill, database
  policies or build scripts) and the version or commit;
- steps to reproduce, or a proof of concept;
- the impact you expect, for example reading another owner's skills, bypassing authentication, reading files outside the
  directories the CLI is meant to touch, installing content that was not reviewed, or leaking a stored credential.

Never include real credentials, tokens or other people's data in a report. Use placeholder values.

## Scope

In scope: this repository's code, including the row-level security policies in `drizzle/`, the authentication and
identity code in `lib/`, the MCP server, and the `headjack` CLI, including how it stores credentials, scans sources and
links skills into an agent harness's skills directory.

Out of scope: any instance other than the maintainers' own, and vulnerabilities in third-party services (Vercel, Neon,
Clerk, the AI Gateway), in dependencies or in Node.js itself, which should go to their maintainers. A third-party issue
that this code makes exploitable is in scope.

## Supported versions

Only the latest commit on the default branch receives security fixes.
