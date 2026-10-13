import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirm, askYesNo } from '../../cli/prompt.mjs';
import { scriptedPrompt } from '../helpers.mjs';

test('confirm accepts y and YES; empty and s are no', () => {
  for (const yes of ['y', 'YES', ' Yes ', 'Y']) assert.equal(confirm(yes), true, yes);
  for (const no of ['', 's', 'S', 'si', 'n', 'no', 'yep', 'nyes']) assert.equal(confirm(no), false, no);
});

test('askYesNo re-asks on s and accepts n', async () => {
  const ctx = { prompt: scriptedPrompt(['s', 'n']) };
  assert.equal(await askYesNo(ctx, 'Work content? [y/n] '), false);
  assert.deepEqual(ctx.prompt.asked, ['Work content? [y/n] ', 'Work content? [y/n] ']);
});

test('askYesNo accepts y, yes, n and no in any case, and re-asks on empty', async () => {
  for (const [answers, expected] of [[['Y'], true], [['yes'], true], [['NO'], false], [['', ' n '], false], [['x', 'YeS'], true]]) {
    const ctx = { prompt: scriptedPrompt(answers) };
    assert.equal(await askYesNo(ctx, 'q? '), expected, answers.join('|'));
    assert.equal(ctx.prompt.remaining.length, 0);
  }
});
