# Local suggestion calibration

How the local suggestion rule (`lib/suggest-rule.mjs`, `lib/suggest-local.mjs`) was tuned, and what it measured. The
prompts themselves are not published: half of the first set came from the maintainer's own sessions.

## Result

Measured against a second blind set of 70 prompts that nothing was tuned on: 40 English and 30 Spanish, 32 of them
needing no skill.

| | Suggestions right | Wrong suggestions | Prompts that got their skill |
|---|---|---|---|
| Before (`localMinGap` 1.11, 2 suggestions per prompt) | 39% (33/85) | 52 | 87% (33/38) |
| After (`localMinGap` 5.5, `localMinGapEs` 2.5) | 87% (26/30) | 4 | 68% (26/38) |

Per language, after: English 89% right (16/18), recall 73%; Spanish 83% right (10/12), recall 63%.

The trade is deliberate. Before, about six suggestions in ten were wrong, which teaches people to ignore the block.
After, about one in eight is wrong, and roughly a third of the skills that would help are not offered.

## What changed and why

Each change was tested on the tuning set before it was kept.

1. **Stop words** (`lib/stopwords.mjs`). FTS5 searched every word of the prompt. "the", "can you", "de" and "con"
   matched almost every skill, and a skill written in Spanish ranked first for nearly any Spanish prompt, including
   "si me parece bien".
2. **Spanish prompts search the Spanish example requests first.** Each table ranks on its own, and a rank tie went to the
   English table, so its noisy first hit beat the Spanish table's good one.
3. **English prompts search the English text only.** The Spanish example requests share loanwords and product names with
   English prompts ("podcast", "neon"), and those matches were mostly wrong. On the tuning set, English precision went
   from 62% to 78% at a cost of 2 of 51 English hits.
4. **One gap threshold per table.** Scores in the Spanish table (one short column, no stemming) run on a smaller scale than
   the English text, so `localMinGapEs` is separate from `localMinGap`.

Tried and dropped, because neither changed which skill ranked first: reweighting the English columns (name,
description, tags, body), and fusing the two tables by reciprocal rank. A gap relative to the top score separated
right from wrong no better than the plain gap. Extra signals (rare "anchor" words, a minimum score) fit the tuning set
better and did worse under cross-validation.

## Method

- **Vault:** 152 skills, all with Spanish example requests (`enrichment_v` set).
- **Tuning set:** 159 prompts. 99 were written for the purpose, half of them taken from real sessions. 60 came from the
  first blind set, folded in after one look, because deciding change 3 on it would have leaked it into tuning.
- **Blind sets:** written by a separate agent from the skill inventory alone, with no access to the ranking code. They
  include hard negatives: an env var named after a product, a button labelled "Export to PDF", a dependency bump.
- **Fit:** every `(localMinGap, localMinGapEs)` pair from 1 to 8 was scored on the tuning set at one suggestion per
  prompt. The defaults sit in the middle of the plateau where precision is highest before recall drops: 83% right and
  44% recall on the tuning set. On the blind set, one or two suggestions per prompt gave the same result.
- **Floor:** the synthetic-vault derivation (`scripts/derive-local-gap.mjs`) is kept as a lower bound. The default must
  still let at most one random two-word query in ten through.

## Limits

- The gaps are bm25 score differences, so they depend on the vault. A vault much smaller or larger than 152 skills, or
  one without Spanish example requests, needs its own values: `headjack suggest --calibrate` fits both thresholds
  against your own `eval.json`.
- Most remaining misses are lexical. A prompt that names no product and shares few words with the skill's text (for
  example "export every track as its own wav stem" for `suno-studio`) does not rank the skill first, whatever the
  threshold. Closer skills from the same family also trade places: `neon-postgres` against `neon-postgres-branches`,
  `test-slack-app` against `create-slack-app`.
- Hosted mode was not re-tuned here.
