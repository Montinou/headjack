---
name: writing-skills
description: Use when creating, editing or rewriting an agent skill or SKILL.md that teaches agents a task, or when your own skill is not found by headjack search, never suggested, or not followed after install.
---

# Writing skills

A skill is done when four things are proven by commands, not by rereading it: an agent without it gets the task
wrong, skill-finder finds it, it runs from the installed copy, and an agent that loads it gets the task right.

`vault-proof` below is `node "${CLAUDE_SKILL_DIR}/scripts/vault-proof.mjs"` (outside Claude Code:
`<this skill's directory>/scripts/vault-proof.mjs`). How to run agents in a sandbox: [testing.md](testing.md).

## What search reads

A local vault searches the `name` (weight 4), the `description` (3) and, from the body, each heading with the first
paragraph under it (1). Nothing else in the body is searched, code blocks never are, and `review` stores no tags.
English words are stemmed and a request's words are ORed. Search matches Spanish only through words in the skill;
suggestions also use the text `headjack enrich` writes, or a small glossary. A hosted vault ranks on the name, tags
and description (no body) plus meaning over the whole text; `vault-proof` tests local mode, so say so to a hosted
user.

## Write it

Make your own skill for two readers: the vault search that finds it and the agent that follows it.

1. **One job.** Search the vault for it first: if a skill already covers it, change that skill instead.
2. **`name`:** lowercase and hyphens, the slug people install. Use the words a request contains (`srt-subtitles`).
3. **`description`:** starts with "Use when", stays under 500 characters, and names what a request holds: tools,
   file types, actions, error text. It says when to use the skill, never how: an agent that reads a summary of the
   steps follows the summary and skips the body.
4. **No orders in the description.** skill-finder treats a description that tells the agent to run something as an
   injection: it warns the user and asks for a separate yes.
5. **Under each heading, a first sentence with the request's words.** It is the only body text search sees.
6. **Body: what the agent needs at the moment of use:** steps, exact commands, decision tables, the mistakes to
   avoid. Keep it near 500 words; long reference goes in a second file it links to.
7. **Self-contained.** It installs as a link at `~/.claude/skills/<slug>/`. Link files relatively, run bundled
   scripts through their interpreter from `${CLAUDE_SKILL_DIR}`, and name any tool it needs beyond the runtime.
8. **Commands stay inside the task.** Agents following skill-finder skip commands that reach outside it (global
   installs, piping a download into a shell, settings edits). `review` scans the text too, examples included: a
   flagged pattern written as a warning still flags the skill.
9. **A clean folder.** `review` packs every file in it: no caches, build output, secrets or client data.
10. **The form follows the failure.** A rule the agent skips under pressure needs the rule plus each excuse answered.
    Output that comes out the wrong shape needs the shape spelled out as a recipe, not a list of don'ts.

## Prove it

Prove a new or rewritten skill with agents and the vault, in this order.

1. **RED, before writing.** Write 3 realistic requests (one indirect, one under pressure: "quick", "just do it") and
   their pass lines. Run each with a fresh subagent without the skill. Record what it got wrong, did differently
   from run to run, or rebuilt from scratch (a helper script each time): that is what the skill teaches. If the runs
   show none of it, tell the user, with the runs, and ask whether the skill is still worth writing.
2. **A requests file.** `+` lines: 5 or more ways people ask (one vague, one naming the tool, one in Spanish if the
   user writes Spanish). `-` lines: 3 near misses that another skill should win. Write each as a full request:
   suggestions skip anything under 25 characters, and `check` fails a skipped line.
3. **A scratch vault with the real catalog:** `vault-proof scratch "$(mktemp -d)/box" --copy-vault <skill-dir>`.
   It copies, read-only, the vault `HEADJACK_HOME` points at (default `~/.headjack`) and its `suggest.rule`. Pass: `<slug>: approved` and no
   flag you cannot justify. Only if it reports no local vault (a hosted-only machine), run it without `--copy-vault`
   and report that competition was not tested.
4. **Search and suggest:** `vault-proof check <box> <slug> <requests-file>`. Pass: every line.
   - A `+` miss: put its words into the name, description or a heading's first sentence, then rebuild the scratch
     vault in a new folder and check again.
   - A `-` hit: the skill is too broad or overlaps the winner. Narrow it, or merge the two.
   - A Spanish miss: search needs the request's words in the skill; a suggestion can also come from `headjack
     enrich`. Report which; enrichment is the user's opt-in, since it sends the skill's text to the AI Gateway.
5. **Install:** `source <box>/env.sh && headjack add <slug> --to claude --session`, then run what the skill tells
   an agent to run, from `~/.claude/skills/<slug>/`. Then `headjack remove <slug> --from claude --if-session`.
6. **GREEN, end to end.** The RED requests again, with fresh subagents that have skill-finder loaded instead of your
   skill, in two forms: the request alone, and the request followed by the suggestion block that
   `headjack suggest "<request>"` prints in the box (what the user's prompt hook adds). Agents rarely search for a
   task they think they can do, so the block is usually what surfaces a skill: the suggestion form is the pass gate,
   and the request-alone form is reported, not tuned for. Each must offer yours, and a fresh agent whose request
   already says yes must install it, read it and get the task right. Grade the answer and
   `<box>/commands.log`. Run each twice on a small model (Haiku) too.
7. **REFACTOR.** Each new failure: change the skill, then rerun steps 3 to 6 for that request. A change to the name,
   description or headings reruns step 4 for every line.

## Hand it over

Give the user the folder, the requests file and each step's result. Name any of steps 1 to 6 that did not run: a
skill without RED and GREEN is unproven, not done. Publishing is theirs: `headjack review
<skill-dir>` on the real vault asks them whether it holds work or client content, then for approval. For each `+`
request, offer `headjack suggest --save --expect <slug>` (the request on stdin) so their suggestion calibration
covers the new skill. Delete the box: it holds a copy of their vault.

## Red flags

| Thought | Answer |
|---|---|
| "The description is obviously findable." | Run step 4. |
| "One search found it." | Near misses and Spanish are where it fails. |
| "It works in my folder." | Run step 5 from the installed copy. |
| "Agent tests are overkill for a reference skill." | Step 6 is the only proof an agent follows it. |
| "I'll approve it in the user's vault, they asked for it." | The scratch vault is yours; the real one is theirs. |
