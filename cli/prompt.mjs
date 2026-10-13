// Answers to the CLI's yes/no prompts. Only y/yes (any case) is a yes, so a habitual Spanish "s" never reads as one.
const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

// A [y/N] confirmation: true only for y/yes; anything else, including an empty answer, is no.
export function confirm(answer) {
  return YES.has(String(answer).trim().toLowerCase());
}

// A question that needs an explicit answer: asked again until it is y, yes, n or no (any case).
export async function askYesNo(ctx, question) {
  for (;;) {
    const answer = String(await ctx.prompt(question)).trim().toLowerCase();
    if (YES.has(answer)) return true;
    if (NO.has(answer)) return false;
  }
}
