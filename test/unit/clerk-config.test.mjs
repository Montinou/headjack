import { test } from "node:test";
import assert from "node:assert/strict";
import { clerkConfigured } from "../../lib/clerk-config.mjs";
test("Clerk is configured only when both nonblank keys are available", () => {
  for (const env of [
    {},
    { CLERK_SECRET_KEY: "secret" },
    { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "public" },
    { CLERK_SECRET_KEY: " ", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "public" },
  ])
    assert.equal(clerkConfigured(env), false);
  assert.equal(
    clerkConfigured({
      CLERK_SECRET_KEY: "secret",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "public",
    }),
    true,
  );
});
