import { test, expect } from "@playwright/test";
import { encryptOverrides } from "flags";
import { browserConfig } from "../../playwright.config";
test("unmodified app with missing Clerk keys returns useful UI and fail-closed private API", async ({
  page,
  context,
}) => {
  // The unmocked dev server compiles `/` and `/api/skills` cold inside this test.
  test.setTimeout(browserConfig.startupTimeout);
  const token = await encryptOverrides(
    { "premium-ui": true, "clerk-auth": true },
    browserConfig.flagsSecret,
  );
  await context.addCookies([
    {
      name: "vercel-flag-overrides",
      value: token,
      url: `http://localhost:${browserConfig.smokePort}`,
    },
  ]);
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Sign-in unavailable" }),
  ).toBeVisible();
  const api = await page.request.get("/api/skills");
  expect(api.status()).toBe(401);
});
