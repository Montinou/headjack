import test from "node:test";
import assert from "node:assert/strict";
const { skillAddCommand, safeSourceUrl } =
  await import("../../lib/ui/commands.mjs").catch(() => ({}));
for (const [slug, expected] of [
  ["-leading", "headjack add -- '-leading'"],
  ["owner's-skill", "headjack add -- 'owner'\\''s-skill'"],
  ["plug@market:skill", "headjack add -- 'plug@market:skill'"],
  ["$(touch /tmp/nope)", "headjack add -- '$(touch /tmp/nope)'"],
])
  test(`shell command quotes ${slug} as one operand`, () =>
    assert.equal(skillAddCommand?.(slug), expected));
for (const value of [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "//evil.example",
  "/relative",
  "",
  null,
  42,
])
  test(`source URL rejects ${String(value)}`, () =>
    assert.equal(safeSourceUrl?.(value), null));
for (const value of [
  "https://example.com/repo?ref=main#readme",
  "http://localhost:8080/repo",
])
  test(`source URL allows ${value}`, () =>
    assert.equal(safeSourceUrl?.(value), value));
