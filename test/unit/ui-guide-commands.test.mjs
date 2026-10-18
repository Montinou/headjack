import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import vm from "node:vm";

const { GUIDE_COMMANDS } = await import("../../lib/ui/guide-commands.mjs");

const EXPECTED = [
  "headjack --help",
  "headjack harness detect",
  'headjack search --purpose manual -- "render a video with remotion"',
  "headjack suggest --enable --hosted",
  "headjack add -- 'your-skill'",
  "headjack add --session -- 'your-skill'",
  "headjack pull",
  "headjack list --json",
  "headjack verify",
  "headjack remove --if-session -- 'your-skill'",
  "headjack updates",
  "headjack review --path 'skills/your-skill' --slug 'your-skill' -- 'https://github.com/owner/repository'",
  "headjack import --dry-run",
];

const source = await readFile(new URL("../../cli/headjack.mjs", import.meta.url), "utf8");
const USAGE = source.match(/const USAGE = `([\s\S]*?)`;/)?.[1];
const OPTIONS_TEXT = source.match(/const OPTIONS = (\{[\s\S]*?\n\});/)?.[1];
const OPTIONS = OPTIONS_TEXT ? vm.runInNewContext(`(${OPTIONS_TEXT})`) : undefined;
const usageLines = (USAGE ?? "").split("\n").map((line) => line.trim());

// Minimal POSIX-style word splitting: single quotes are literal, double quotes group words.
function shellSplit(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, i + 1);
      assert.notEqual(end, -1, `unterminated quote in ${command}`);
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (word !== null) words.push(word);
  return words;
}

test("the guide shows exactly the thirteen pinned commands", () =>
  assert.deepEqual(GUIDE_COMMANDS.map((entry) => entry.command), EXPECTED));

test("the search command carries the label search", () =>
  assert.equal(GUIDE_COMMANDS.find((entry) => entry.command.startsWith("headjack search"))?.label, "search"));

test("labels and ids are unique and every entry names a guide section", () => {
  assert.equal(new Set(GUIDE_COMMANDS.map((entry) => entry.label)).size, GUIDE_COMMANDS.length);
  assert.equal(new Set(GUIDE_COMMANDS.map((entry) => entry.id)).size, GUIDE_COMMANDS.length);
  for (const entry of GUIDE_COMMANDS)
    assert.ok(["access", "find", "install", "review"].includes(entry.section), entry.id);
});

test("no command installs from npm, logs in, carries a key or uploads with a bare import", () => {
  for (const { command } of GUIDE_COMMANDS) {
    assert.doesNotMatch(command, /npm install|headjack login|sk_live_|sk_test_/);
    assert.notEqual(command.trim(), "headjack import");
  }
});

test("the CLI source exposes USAGE and the parseArgs options object", () => {
  assert.ok(USAGE, "USAGE not found in cli/headjack.mjs");
  assert.equal(typeof OPTIONS, "object", "OPTIONS not found in cli/headjack.mjs");
});

for (const { command } of GUIDE_COMMANDS)
  test(`${command} matches the CLI usage and parses strictly`, () => {
    const words = shellSplit(command);
    assert.equal(words[0], "headjack");
    if (words[1] !== "--help") {
      const subcommand = words[1];
      const lines = usageLines.filter((line) => line.startsWith(`headjack ${subcommand} `) || line === `headjack ${subcommand}`);
      assert.ok(lines.length, `no USAGE line starts with headjack ${subcommand}`);
      const flags = words.slice(2, words.includes("--") ? words.indexOf("--") : undefined).filter((word) => word.startsWith("--") && word !== "--" && word !== "--help");
      for (const flag of flags) {
        const onLine = new RegExp(`(^|[\\s\\[|])${flag}(?=[\\s\\]|=]|$)`);
        assert.ok(lines.some((line) => onLine.test(line)), `${flag} is not on the headjack ${subcommand} USAGE line`);
      }
    }
    assert.doesNotThrow(() => parseArgs({ args: words.slice(1), options: OPTIONS, allowPositionals: true, strict: true }));
  });
