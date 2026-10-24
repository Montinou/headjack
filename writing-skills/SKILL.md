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

Default local full-text search reads the `name` (weight 4), the `description` (3), stored tags (2) when present,
and, from the body, each heading with the first paragraph under it (1); code blocks never enter that full-text index.
English words are stemmed and request words are ORed. Keyed local hybrid retrieval also uses embeddings of stored chunks, with full-text
fallback. A hosted vault combines name, tags and description full-text search with semantic retrieval.
`vault-proof` tests local mode; report which retrieval configuration was exercised. `review` stores no tags:
authoring tags does not automatically import them.

## Write it

Make your own skill for two readers: the vault search that finds it and the agent that follows it.
Write skills in English: description, headings, body, use cases, examples and tags where supported, regardless of
the user's language. Preserve literal technical identifiers, errors, tool and file names, including
`relation "users" does not exist`. Reply to the user in their language. Existing imported non-English skills need
migration: report that need, never silently rewrite them.

Agents formulate English search requests; the CLI expects English, not a translation or language-detection
service. This is an agent authoring/search contract, not removal of runtime bilingual support.

1. **One job.** Search the vault for it first: if a skill already covers it, change that skill instead.
2. **`name`:** lowercase and hyphens, the slug people install. Use the words a request contains (`srt-subtitles`).
3. **`description`:** starts with "Use when", stays under 500 characters, and names what a request holds: tools,
   file types, actions, error text. It says when to use the skill, never how: an agent that reads a summary of the
   steps follows the summary and skips the body.
4. **No orders in the description.** skill-finder treats a description that tells the agent to run something as an
   injection: it warns the user and asks for a separate yes.
5. **Under each heading, a first sentence with the request's concrete English terms.** Name inputs, actions and
   outcomes, and distinguish adjacent tasks outside scope; avoid keyword stuffing. This is the body text local
   full-text search sees, not a limit on semantic retrieval.
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
2. **A requests file.** Record agent-normalized English requests. `+` lines: 5 or more ways to ask (one vague,
   one naming the tool), with concrete inputs, actions and expected outcomes. `-` lines: 3 English near misses
   naming adjacent tasks that another skill should win. Preserve literal identifiers and errors. Write full requests:
   suggestions skip anything under 25 characters, and `check` fails a skipped line. Keep multilingual user prompts
   and their English-query mappings separately for the end-to-end agent check.
3. **A scratch vault with the real catalog:** `vault-proof scratch "$(mktemp -d)/box" --copy-vault <skill-dir>`.
   It copies, read-only, the vault `HEADJACK_HOME` points at (default `~/.headjack`) and its `suggest.rule`. Pass: `<slug>: approved` and no
   flag you cannot justify. Only if it reports no local vault (a hosted-only machine), run it without `--copy-vault`
   and report that competition was not tested.
4. **Search and suggest:** `vault-proof check <box> <slug> <requests-file>`. Pass: every line.
   - A `+` miss: inspect the agent's English query, then clarify genuinely missing inputs, actions or outcomes in
     the description or a heading's first sentence. Rebuild the scratch vault in a new folder and check again;
     do not stuff keywords or broaden the skill to chase a hit.
   - A `-` hit: the skill is too broad or overlaps the winner. Narrow it, or merge the two.
   - A multilingual miss: test agent normalization first; do not add Spanish words or require `headjack enrich`
     to repair it. Existing bilingual retrieval remains supported; enrichment is separate user opt-in.
5. **Install:** `source <box>/env.sh && headjack add <slug> --to claude --session`, then run what the skill tells
   an agent to run, from `~/.claude/skills/<slug>/`. Then `headjack remove <slug> --from claude --if-session`.
6. **GREEN, end to end.** The RED requests again, with fresh subagents that have skill-finder loaded instead of your
   skill. Include Spanish and another user language: grade actual English queries, unchanged literal identifiers
   and replies in the user's language. Test two forms: the user request alone, and the request followed by the
   suggestion block from `headjack suggest "<agent-normalized English request>"` in the box. This checks agent
   normalization, not automatic translation by a raw prompt hook. Agents rarely search for a
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
