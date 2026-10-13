# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository
(`Montinou/headjack`): open the **Security** tab, choose **Report a vulnerability**, and describe the issue. Do not open a
public issue, pull request or discussion for a suspected vulnerability.

A useful report includes:

- the affected component (the `headjack` CLI, the local SQLite vault, the launcher or the skill) and the version or commit;
- steps to reproduce, or a proof of concept;
- the impact you expect, for example reading files outside the directories the CLI is meant to touch, installing content
  that was not reviewed, or leaking a stored credential.

Never include real credentials, tokens or other people's data in a report. Use placeholder values.

## Scope

In scope: the code in this repository, including how the CLI stores credentials, scans sources and links skills into an
agent harness's skills directory.

Out of scope: servers run by other people, and vulnerabilities in third-party services or in Node.js itself, which should
go to their maintainers. A third-party issue that this code makes exploitable is in scope.

## Supported versions

Only the latest commit on the default branch receives security fixes.
