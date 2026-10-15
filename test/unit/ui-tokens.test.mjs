import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOKENS, TEXT_PAIRS, contrastRatio } from "../../lib/ui/tokens.mjs";

const EXPECTED_TOKENS = {
  paper: "#F6F2EA",
  paperRaised: "#FBF9F4",
  rule: "#E3DCCD",
  inkTitle: "#152150",
  ink: "#2B2A26",
  inkMuted: "#6B6457",
  cobalt: "#1E4FD8",
  cobaltHover: "#1A43B8",
  cobaltSoft: "#E8EEFC",
  success: "#256B40",
  warning: "#8F5B0E",
  danger: "#B42318",
};

const CSS_PROPERTIES = {
  paper: "--paper",
  paperRaised: "--paper-raised",
  rule: "--rule",
  inkTitle: "--ink-title",
  ink: "--ink",
  inkMuted: "--ink-muted",
  cobalt: "--cobalt",
  cobaltHover: "--cobalt-hover",
  cobaltSoft: "--cobalt-soft",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
};

const css = () =>
  readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

const colour = (name) => (name === "white" ? "#FFFFFF" : TOKENS[name]);

test("TOKENS holds the exact spec values", () => {
  assert.deepEqual(TOKENS, EXPECTED_TOKENS);
});

test("TEXT_PAIRS holds every binding contrast pair from spec section 5", () => {
  const expected = [];
  for (const fg of [
    "inkTitle",
    "ink",
    "inkMuted",
    "cobalt",
    "success",
    "warning",
    "danger",
  ]) {
    for (const bg of ["paper", "paperRaised", "cobaltSoft"]) {
      expected.push([fg, bg]);
    }
  }
  expected.push(["white", "cobalt"], ["white", "cobaltHover"]);
  const key = ([fg, bg]) => `${fg}/${bg}`;
  assert.equal(TEXT_PAIRS.length, 23);
  assert.deepEqual(
    TEXT_PAIRS.map(key).sort(),
    expected.map(key).sort(),
  );
});

test("every text pair reaches WCAG AA 4.5:1", () => {
  for (const [fg, bg] of TEXT_PAIRS) {
    const ratio = contrastRatio(colour(fg), colour(bg));
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test("contrastRatio matches the recorded spec ratios", () => {
  const round = (n) => Math.round(n * 100) / 100;
  assert.equal(round(contrastRatio("#FFFFFF", "#1E4FD8")), 6.63);
  assert.equal(round(contrastRatio("#8F5B0E", "#E8EEFC")), 4.92);
  assert.equal(
    contrastRatio("#1E4FD8", "#FFFFFF"),
    contrastRatio("#FFFFFF", "#1E4FD8"),
  );
});

test("globals.css declares every token custom property with its value", () => {
  const text = css();
  for (const [name, property] of Object.entries(CSS_PROPERTIES)) {
    const declaration = new RegExp(
      `${property}\\s*:\\s*${EXPECTED_TOKENS[name]}\\s*;`,
      "i",
    );
    assert.match(text, declaration, `${property} must be ${EXPECTED_TOKENS[name]}`);
  }
});

test("globals.css layers Tailwind without a global preflight", () => {
  const text = css();
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  assert.ok(
    withoutComments.startsWith("@layer theme, base, components, utilities;"),
    "first statement must declare the layer order",
  );
  assert.ok(!text.includes('@import "tailwindcss";'));
  assert.ok(
    text.includes("@custom-variant dark (&:where(.dark, .dark *));"),
    "dark variant must follow a .dark class, not the OS scheme",
  );
  assert.ok(text.includes("color-scheme: light"));
});

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");

// Walks the CSS block structure and returns every block with its prelude, its
// body and the preludes of the blocks that enclose it.
const cssBlocks = (text) => {
  const source = stripComments(text);
  const blocks = [];
  const stack = [];
  let prelude = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      const block = {
        prelude: prelude.trim(),
        ancestors: stack.map((open) => open.prelude),
        start: i + 1,
      };
      stack.push(block);
      blocks.push(block);
      prelude = "";
    } else if (ch === "}") {
      const block = stack.pop();
      assert.ok(block, `unbalanced } at offset ${i}`);
      block.body = source.slice(block.start, i);
      prelude = "";
    } else if (ch === ";") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  assert.equal(stack.length, 0, "unbalanced braces in globals.css");
  return blocks;
};

const isLayer = (prelude) => /^@layer\b/.test(prelude);

test("globals.css never imports Tailwind's global preflight", () => {
  const imports = stripComments(css()).match(/@import[^;]*;/g) ?? [];
  assert.ok(imports.length > 0, "globals.css must import Tailwind");
  for (const statement of imports) {
    assert.doesNotMatch(statement, /tailwindcss\/preflight/, statement);
  }
});

test("globals.css keeps the Tailwind MIT notice above the scoped preflight copy", () => {
  const text = css();
  const license = readFileSync(
    new URL("../../node_modules/tailwindcss/LICENSE", import.meta.url),
    "utf8",
  );
  const preflight = text.indexOf("body.premium-ui ::file-selector-button {");
  assert.notEqual(preflight, -1, "the scoped preflight copy must exist");
  const comments = text.slice(0, preflight).match(/\/\*[\s\S]*?\*\//g) ?? [];
  const words = (s) => s.split(/\s+/).filter(Boolean).join(" ");
  const notice = words(license);
  assert.ok(
    comments.some((comment) => words(comment.slice(2, -2)).includes(notice)),
    "the full Tailwind Labs copyright and permission notice must precede the preflight copy",
  );
});

test("@theme inline sets 8 px control and 12 px card radii", () => {
  const theme = cssBlocks(css()).find((block) => block.prelude === "@theme inline");
  assert.ok(theme, "@theme inline block must exist");
  assert.match(theme.body, /--radius-md\s*:\s*0\.5rem\s*;/);
  assert.match(theme.body, /--radius-lg\s*:\s*0\.75rem\s*;/);
});

test("--input maps control borders to #7F7768 with 3:1 non-text contrast", () => {
  assert.match(css(), /--input\s*:\s*#7F7768\s*;/i);
  for (const surface of ["paper", "paperRaised"]) {
    const ratio = contrastRatio("#7F7768", TOKENS[surface]);
    assert.ok(ratio >= 3, `#7F7768 on ${surface} is ${ratio.toFixed(2)}:1`);
  }
});

test(".metadata-scroll caps its height and scrolls vertically", () => {
  const rule = cssBlocks(css()).find((block) => block.prelude === ".metadata-scroll");
  assert.ok(rule, ".metadata-scroll rule must exist");
  assert.match(rule.body, /max-height\s*:\s*[^;]+;/);
  assert.match(rule.body, /overflow-y\s*:\s*auto\s*;/);
});

test("every icon tile tint has a selector", () => {
  const preludes = cssBlocks(css()).map((block) => block.prelude);
  for (const tint of ["cobalt", "teal", "amber", "rose", "violet", "green"]) {
    assert.ok(
      preludes.some((prelude) => prelude.includes(`[data-tint="${tint}"]`)),
      `[data-tint="${tint}"] must exist`,
    );
  }
});

test("a :focus-visible rule sits outside every @layer block", () => {
  const unlayered = cssBlocks(css()).filter(
    (block) =>
      block.prelude.includes(":focus-visible") &&
      !isLayer(block.prelude) &&
      !block.ancestors.some(isLayer),
  );
  assert.ok(unlayered.length > 0, "an unlayered :focus-visible rule must exist");
});
