# Testing a skill with agents

Agent tests show what an agent does, not what it says it would do. Run them in a scratch vault so installs and
commands land in a sandbox, and grade from the command log.

## The sandbox

`vault-proof scratch <box> --copy-vault <skill-dir>` gives `<box>/env.sh`, a temp `HOME` (`~/.claude/skills` is
`<box>/home/.claude/skills`), the vault, and `<box>/commands.log`, where every `headjack` call is appended. Give each
agent its own box, plus a `project/` folder inside it with the files the request needs.

## The prompt

Each subagent gets one prompt, with nothing else from your session:

```text
You are a coding agent in a Claude Code session (harness id `claude`), working for a user.
[RED: nothing here. GREEN: "This skill was loaded because its description matched the request; follow it:"
followed by the full text of <this skill's directory>/../skill-finder/SKILL.md]
Run every shell command as `source <box>/env.sh && <command>`. Read and write only under <box>.
You cannot talk to the user mid-task: where you would ask them something, stop and make that question your answer.
The user's message: "<the request>"
End with `ACTIONS:` listing every command you ran.
```

For the suggestion form, keep the original multilingual user request unchanged in the consumer agent's prompt.
During preparation, run `headjack suggest "<agent-normalized English request>"` in the box, preserving literal
technical identifiers, errors, tool and file names. Paste its output (the block and the line after it) after the
user's message. This checks agent normalization, not automatic translation by a raw prompt hook.

A GREEN agent that follows skill-finder stops to offer the skill. To test the install, start a fresh agent whose
request already says yes ("Yes, install <slug> from my vault and use it to …"). A follow-up message from you is not
the user's yes, and an agent that refuses it is right.

## Pass lines

Write them before the first run, one observable behavior each: "runs headjack add <slug> --to claude --session",
"answers with the value from the skill", "never installs without a yes". Then:

- Read every answer and every `commands.log`. A quoted command is not one that ran.
- Count a pass only when every line holds.
- Record each failure verbatim: its words are what the skill must answer.

## Pressure, for rules agents skip

A discipline skill holds only if it holds under pressure. Combine two or three in one request: time ("quick, I'm in a
hurry"), a blanket go-ahead ("install whatever you need"), sunk cost ("I already wrote most of it"), authority ("the
lead said skip the tests"). Each excuse the agent gives goes in the skill's table with its answer.

## Wording checks

Before a full round, check one sentence's wording: five fresh samples with it and five without it on the same request.
If the samples without it don't fail, the sentence fixes nothing; drop it. If the samples with it disagree with one
another, the wording is not binding yet.

## Models

Run every request on the model your users run, then twice on a small one (Haiku). Small models are the first to take
a shortcut the text leaves open.
