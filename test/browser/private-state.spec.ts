import { test, expect } from "@playwright/test";
import { session, row, openLibrary, deferredReads, releaseReads } from "./library-fixtures";
for (const status of [200, 401])
  test(`late owner A ${status} cannot appear or expire owner B; sign-out cancels pending B`, async ({ page }) => {
    await deferredReads(page, "/api/skills?");
    await page.route("**/api/skills?*", (route) => route.fulfill({json: {
      skills: [row("Owner B skill")], total: 1, limit: 24, offset: 0,
    }}));
    await openLibrary(page);
    await expect.poll(() => page.evaluate(() => (window as any).deferredRead.started)).toBeGreaterThan(0);
    await page.evaluate(() => { (window as any).deferredRead.enabled = false; });
    await session(page, "owner_b", "session_b");
    await expect(page.getByRole("link", {name: "Owner B skill", exact: true})).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).deferredRead.aborted)).toBeGreaterThan(0);
    await releaseReads(page, status, status === 200
      ? {skills: [row("Owner A secret")], total: 1, limit: 24, offset: 0}
      : {error: {message: "Expired previous owner"}});
    await expect(page.getByText("Owner A secret")).toHaveCount(0);
    await expect(page.getByRole("link", {name: "Owner B skill", exact: true})).toBeVisible();
    expect(await page.evaluate(() => (window as any).deferredRead.expired)).toBe(0);
    const before = await page.evaluate(() => { (window as any).deferredRead.enabled = true; return (window as any).deferredRead.started; });
    await page.getByLabel("Kind", {exact: true}).selectOption("plugin");
    await expect.poll(() => page.evaluate(() => (window as any).deferredRead.started)).toBeGreaterThan(before);
    await session(page, null);
    await expect.poll(() => page.evaluate(() => (window as any).deferredRead.aborted)).toBeGreaterThan(0);
    await releaseReads(page, 200, {skills: [row("Late B private")], total: 1, limit: 24, offset: 0});
    await expect(page.getByRole("heading", {name: "A private home for your skills."})).toBeVisible();
    await expect(page.getByText("Late B private")).toHaveCount(0);
    await expect(page.getByText("Owner B skill")).toHaveCount(0);
  });
test("401 blocks sibling private successes even while Clerk stays signed in, retry revalidates", async ({
  page,
}) => {
  await page.route("**/api/qa-first", (route) =>
    route.fulfill({ json: { name: "Sibling secret" } }),
  );
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let expired = true;
  await page.route("**/api/qa-second", async (route) => {
    if (expired) await hold;
    await route.fulfill(
      expired
        ? {
            status: 401,
            json: {
              error: { code: "unauthorized", message: "Session expired" },
            },
          }
        : { json: { name: "Second current" } },
    );
  });
  await page.route("**/fixture-clerk-reload", (route) =>
    route.fulfill({
      json: {
        isLoaded: true,
        userId: "owner_a",
        sessionId: "session_a",
        status: "active",
      },
    }),
  );
  await page.goto("/qa-private-resources");
  await session(page);
  await expect(page.getByText("Sibling secret")).toBeVisible();
  release();
  await expect(
    page.getByRole("heading", { name: "Sign in to continue" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-component="status-card"]').getByRole("heading", {
      level: 1,
      name: "Sign in to continue",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("main h1")).toHaveCount(1);
  await expect(page.getByText("Sibling secret")).toHaveCount(0);
  expired = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Second current")).toBeVisible();
});
test("pagehide clears before freeze, pageshow waits for reload and failed reload stays blocked", async ({
  page,
}) => {
  await page.route("**/api/skills?*", (route) =>
    route.fulfill({
      json: {
        skills: [row("Private before freeze")],
        total: 1,
        limit: 24,
        offset: 0,
      },
    }),
  );
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let fail = true;
  await page.route("**/fixture-clerk-reload", async (route) => {
    if (fail) await hold;
    await route.fulfill(
      fail
        ? { status: 500, json: { error: "reload failed" } }
        : {
            json: {
              isLoaded: true,
              userId: "owner_a",
              sessionId: "session_a",
              status: "active",
            },
          },
    );
  });
  await openLibrary(page);
  await expect(
    page.getByText("Private before freeze", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect(
    page.getByText("Private before freeze", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(
    page.getByText("Private before freeze", { exact: true }),
  ).toHaveCount(0);
  release();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    page.getByText("Private before freeze", { exact: true }),
  ).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Private before freeze", { exact: true }),
  ).toBeVisible();
});
test("history restoration clears old data until current session is revalidated", async ({
  page,
}) => {
  await page.route("**/api/skills?*", (route) =>
    route.fulfill({
      json: { skills: [row()], total: 52, limit: 24, offset: 0 },
    }),
  );
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/fixture-clerk-reload", async (route) => {
    await hold;
    await route.fulfill({
      json: { isLoaded: true, userId: null, sessionId: null, status: "ended" },
    });
  });
  await openLibrary(page);
  await expect(page.getByText("Alpha skill", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page).toHaveURL(/view=list/);
  await page.goBack();
  await expect(page.getByText("Alpha skill", { exact: true })).toHaveCount(0);
  release();
  await expect(
    page.getByRole("heading", { name: "A private home for your skills." }),
  ).toBeVisible();
});
