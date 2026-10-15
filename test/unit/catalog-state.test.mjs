import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCatalogState,
  serializeCatalogState,
  changeCatalogState,
} from "../../lib/ui/catalog-state.mjs";
test("URL filters and list view roundtrip with normalized repeated tags", () => {
  const state = parseCatalogState(
    new URLSearchParams(
      "q=+React+&kind=skill&tag=Three.js,Front_End&tag=threejs&view=list&offset=48",
    ),
  );
  assert.deepEqual(state, {
    q: "React",
    kind: "skill",
    tags: ["threejs", "front-end"],
    view: "list",
    offset: 48,
  });
  assert.equal(
    serializeCatalogState(state).toString(),
    "q=React&kind=skill&tag=threejs&tag=front-end&view=list&offset=48",
  );
});
for (const params of [
  "kind=widget",
  "tag=!!!",
  "tag=a,b,c,d,e,f,g,h,i",
  "offset=-1",
  "offset=1.5",
  "offset=abc",
  "offset=9007199254740992",
  "view=cards",
]) {
  test(`invalid URL ${params} is recoverable validation`, () =>
    assert.throws(
      () => parseCatalogState(new URLSearchParams(params)),
      /Invalid/,
    ));
}
test("changing view retains page while filters and query reset page", () => {
  const base = { q: "", kind: null, tags: [], view: "grid", offset: 48 };
  assert.equal(changeCatalogState(base, { view: "list" }).offset, 48);
  for (const patch of [{ q: "React" }, { kind: "plugin" }, { tags: ["react"] }])
    assert.equal(changeCatalogState(base, patch).offset, 0);
});
