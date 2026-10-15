import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Render the production TSX under the project's Node baseline without a fixture build.
const source = await readFile(
  new URL("../../components/premium/review-metadata.tsx", import.meta.url), "utf8",
);
const runtime = pathToFileURL(createRequire(import.meta.url).resolve("react/jsx-runtime")).href;
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(runtime));
const { ScanFindings, QualityAssessment } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`,
);

for (const key of ["__proto__", "constructor", "toString"]) {
  const hostile = "<script>unknown & recorded</script>";
  // JSON.parse matches an accepted API object; __proto__ is an own data key.
  const unknown = JSON.parse(JSON.stringify({ [key]: { [key]: hostile } }));
  for (const [kind, Component, props] of [
    ["scan", ScanFindings, { flags: [{ rule: "external-url", line: 0, ...unknown }] }],
    ["quality", QualityAssessment, { quality: { reuse: 0, ...unknown } }],
  ]) {
    test(`${kind} preserves unknown ${key} keys and nested values as inert labelled text`, () => {
      const html = renderToStaticMarkup(createElement(Component, props));
      assert.equal(html.split(`<dt>${key}</dt>`).length - 1, 2, "both top-level and nested keys must remain their literal labels");
      assert.ok(html.includes("&lt;script&gt;unknown &amp; recorded&lt;/script&gt;"));
      assert.ok(!html.includes("<script>"), "recorded markup must not execute");
      assert.ok(html.includes("<dd>0</dd>"), "recorded zero remains visible");
    });
  }
}
