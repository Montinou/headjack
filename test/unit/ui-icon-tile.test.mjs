import test from "node:test";
import assert from "node:assert/strict";
import { TILE_TINTS, tintForSlug, iconForKind } from "../../lib/ui/icon-tile.mjs";

test("tile tints are the six spec tints in order", () =>
  assert.deepEqual(TILE_TINTS, ["cobalt", "teal", "amber", "rose", "violet", "green"]));

for (const [slug, tint] of [
  ["detail-skill", "amber"],
  ["search-skill", "rose"],
  ["a", "violet"],
  ["", "teal"],
])
  test(`tintForSlug(${JSON.stringify(slug)}) is ${tint}`, () => assert.equal(tintForSlug(slug), tint));

test("the same slug always gets the same tint", () =>
  assert.equal(tintForSlug("detail-skill"), tintForSlug("detail-skill")));

test("120 slugs cover all six tints", () => {
  const seen = new Set(Array.from({ length: 120 }, (_, i) => tintForSlug(`skill-${i}`)));
  assert.deepEqual([...seen].sort(), [...TILE_TINTS].sort());
});

test("kind maps to icon: plugin puzzle, skill in plugin layers, else book", () => {
  assert.equal(iconForKind("plugin", null), "puzzle");
  assert.equal(iconForKind("skill", "plug@market"), "layers");
  assert.equal(iconForKind("skill", null), "book");
});
