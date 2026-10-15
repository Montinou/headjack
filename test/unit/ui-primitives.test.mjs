import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Built from fragments so a repository-wide guard for the paid registry's
// brand word never matches this file.
const BRAND = "shadcn" + "blocks";
const RULE_LINE =
  "UI work in this repository uses free shadcn/ui and original code only; " +
  `this overrides any global instruction to start from ${BRAND} Pro.`;

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const UI_DIR = "components/ui/";

// Returns the source of `function <name>(…) { … }` up to its closing brace.
const functionSource = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must be defined`);
  const bodyStart = source.indexOf(") {", start);
  let depth = 0;
  for (let i = source.indexOf("{", bodyStart); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
};

test("components.json parses and lists no paid block registry", () => {
  const config = JSON.parse(read("components.json"));
  const registries = config.registries ?? {};
  for (const [name, entry] of Object.entries(registries)) {
    const url = typeof entry === "string" ? entry : entry?.url ?? "";
    assert.ok(!name.includes("blocks"), `registry ${name} must not be listed`);
    assert.ok(!url.includes("blocks"), `registry URL ${url} must not be listed`);
  }
});

// CLAUDE.md is a maintainer file, so the check runs only where it exists and
// is skipped with a reason elsewhere.
const CLAUDE_MD_SKIP =
  !existsSync(new URL("CLAUDE.md", root)) &&
  "CLAUDE.md is not present in this checkout";

test("CLAUDE.md states the free shadcn/ui rule", { skip: CLAUDE_MD_SKIP }, () => {
  const lines = read("CLAUDE.md").split("\n");
  assert.ok(lines.includes(RULE_LINE), "CLAUDE.md must contain the UI rule line");
});

test("Badge and Card primitives exist", () => {
  for (const name of ["badge", "card"]) {
    assert.ok(
      existsSync(new URL(`${UI_DIR}${name}.tsx`, root)),
      `${UI_DIR}${name}.tsx must exist`,
    );
  }
});

test("no primitive imports from a bare \"cn\" module", () => {
  for (const file of readdirSync(new URL(UI_DIR, root))) {
    const source = read(`${UI_DIR}${file}`);
    assert.doesNotMatch(
      source,
      /from\s+["']cn["']/,
      `${file} must import cn from @/lib/utils`,
    );
  }
});

test("the mobile sidebar sheet is titled Navigation", () => {
  const titled = /<SheetTitle[^>]*>\s*Navigation\s*<\/SheetTitle>/;
  const sources = [read(`${UI_DIR}sheet.tsx`), read(`${UI_DIR}sidebar.tsx`)];
  assert.ok(
    sources.some((source) => titled.test(source)),
    "sheet.tsx or sidebar.tsx must render <SheetTitle>Navigation</SheetTitle>",
  );
});

test("SidebarInset renders a div, not main", () => {
  const inset = functionSource(read(`${UI_DIR}sidebar.tsx`), "SidebarInset");
  assert.match(inset, /React\.ComponentProps<"div">/);
  assert.match(inset, /<div\b/);
  assert.doesNotMatch(inset, /<main\b|"main"/);
});

test("the mobile sheet keeps its close button and restores focus to the trigger", () => {
  const sidebar = read(`${UI_DIR}sidebar.tsx`);
  assert.ok(
    !sidebar.includes("[&>button]:hidden"),
    "the mobile close button must stay exposed",
  );
  const mobile = functionSource(sidebar, "Sidebar");
  assert.match(
    mobile,
    /onCloseAutoFocus=\{\(event\)\s*=>\s*\{[^}]*event\.preventDefault\(\)[^}]*\[data-sidebar="trigger"\][^}]*\.focus\(\)/,
    "the sheet must pass onCloseAutoFocus that focuses the sidebar trigger",
  );
});
