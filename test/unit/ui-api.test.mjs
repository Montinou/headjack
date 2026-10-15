import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
// Exercise the production TypeScript module under the project's Node >=20.9 baseline.
const source = await readFile(
  new URL("../../lib/ui/api.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { apiJson, ApiError } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const original = globalThis.fetch;
test.afterEach(() => (globalThis.fetch = original));
test("the UI sends x-headjack-purpose", async () => {
  let options;
  globalThis.fetch = async (_path, init) => {
    options = init;
    return Response.json({ results: [] });
  };
  await apiJson("/api/search?q=react", new AbortController().signal);
  assert.deepEqual(options.headers, { "x-headjack-purpose": "manual" });
});
test("same-origin no-store search sends manual purpose without Authorization", async () => {
  let options;
  globalThis.fetch = async (_path, init) => {
    options = init;
    return Response.json({ results: [] });
  };
  assert.deepEqual(
    await apiJson("/api/search?q=react&k=25", new AbortController().signal),
    { results: [] },
  );
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.cache, "no-store");
  assert.equal(options.headers["x-headjack-purpose"], "manual");
  assert.equal(options.headers.Authorization, undefined);
});
for (const status of [400, 401, 403, 404])
  test(`error envelope maps status ${status}`, async () => {
    globalThis.fetch = async () =>
      Response.json(
        { error: { code: "failure", message: "Recoverable message" } },
        { status },
      );
    await assert.rejects(
      apiJson("/api/skills?limit=24", new AbortController().signal),
      (e) =>
        e instanceof ApiError &&
        e.status === status &&
        e.message === "Recoverable message",
    );
  });
for (const body of [
  "bad json",
  "null",
  '{"skills":false}',
  '{"skills":[],"total":-1,"limit":24,"offset":0}',
  '{"results":[{"slug":"x"}]}',
])
  test(`malformed response is recoverable: ${body}`, async () => {
    globalThis.fetch = async () =>
      new Response(body, { headers: { "content-type": "application/json" } });
    await assert.rejects(
      apiJson(
        body.includes("results") ? "/api/search?q=x" : "/api/skills?limit=24",
        new AbortController().signal,
      ),
      (e) => e instanceof ApiError && e.status === 502,
    );
  });
test("network error is recoverable and cancellation remains AbortError", async () => {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  await assert.rejects(
    apiJson("/api/skills", new AbortController().signal),
    (e) => e instanceof ApiError && e.status === 0,
  );
  globalThis.fetch = async () => {
    throw new DOMException("Aborted", "AbortError");
  };
  await assert.rejects(
    apiJson("/api/skills", new AbortController().signal),
    (e) => e.name === "AbortError",
  );
});

for (const status of [500, 502, 503])
  test(`internal ${status} failure is unavailable without leaking backend details`, async () => {
    globalThis.fetch = async () => Response.json(
      { error: { message: "internal error: provider credentials missing at /private/server" } }, { status });
    await assert.rejects(apiJson("/api/search?q=x", new AbortController().signal),
      (e) => e instanceof ApiError && e.status === status &&
        e.message === "This content is temporarily unavailable. Try again in a moment.");
  });
test("non-JSON internal failure uses the same friendly unavailable copy", async () => {
  globalThis.fetch = async () => new Response("private stacktrace", {status: 500});
  await assert.rejects(apiJson("/api/skills", new AbortController().signal),
    (e) => e instanceof ApiError && e.status === 500 &&
      e.message === "This content is temporarily unavailable. Try again in a moment.");
});
