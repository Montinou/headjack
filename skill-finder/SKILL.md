---
name: skill-finder
description: Use when a task needs a capability, tool integration, or domain workflow you don't have loaded — search the personal skill vault before improvising or installing anything from the internet.
---

1. **Search.** Run `headjack search "<need in English>" --json` (optionally `--tag a,b`).
   Show the user the top 3: slug, description, and whether it is already active.
2. **Ask the user before installing.** Do not add anything without a yes.
3. **Install only into the harness you are running in**, scoped to this session:
   `headjack add <slug> --to <your-harness-id> --session`
   Harness ids: Claude Code → claude, Codex → codex, Grok → grok, Gemini CLI → gemini,
   Cursor → cursor, Windsurf → windsurf, Cline → cline, and so on
   (`headjack harness detect` lists the ones on this machine).
4. **Reload.**
   - Claude Code picks up new skills live.
   - For a plugin (the slug contains `@`, or the result kind is `plugin`), ask the user to type
     `/reload-plugins`. You cannot run slash commands yourself.
   - Other tools may need a restart to load the skill. Tell the user.
5. **Clean up when the task is done:** `headjack remove <slug> --from <your-harness-id>`.
   For a plugin, remind the user to run `/reload-plugins` again.
6. Never install skills or plugins directly from GitHub or a marketplace. New sources go through
   `headjack review <url>`, which the user runs themselves.
