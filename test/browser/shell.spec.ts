import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { browserConfig } from "../../playwright.config";
const fixtureOrigin = `http://localhost:${browserConfig.fixturePort}`;
async function session(
  page: Page,
  userId: string | null,
  sessionId = "session_fixture",
) {
  await expect(page.locator("body")).toHaveAttribute(
    "data-fixture-clerk-ready",
    "true",
  );
  await page.evaluate(
    ({ userId, sessionId }) =>
      window.dispatchEvent(
        new CustomEvent("fixture-clerk-session", {
          detail: {
            isLoaded: true,
            userId,
            sessionId: userId ? sessionId : null,
          },
        }),
      ),
    { userId, sessionId },
  );
}
async function privateReads(page: Page) {
  const reads: string[] = [];
  await page.route("**/api/**", (route) => {
    reads.push(route.request().url());
    return route.fulfill({
      status: 200,
      json: { skills: [], total: 0, limit: 24, offset: 0 },
    });
  });
  return reads;
}
test("UI off preserves the original placeholder and account controls", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "qa-ui", value: "off", url: fixtureOrigin },
  ]);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "headjack", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("API only for now.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Skip to content" })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() => getComputedStyle(document.body).margin),
  ).toBe("8px");
  await expect(page.locator("body")).not.toHaveClass(/premium-ui/);
});
test("auth disabled exposes useful unavailable state and makes no private reads", async ({
  page,
  context,
}) => {
  const reads = await privateReads(page);
  await context.addCookies([
    { name: "qa-auth", value: "off", url: fixtureOrigin },
  ]);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign-in unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
  expect(reads).toEqual([]);
});
test("signed out introduction has working sign-in and invitation controls without private reads", async ({
  page,
}) => {
  const reads = await privateReads(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A private home for your skills." }),
  ).toBeVisible();
  await expect(
    page.locator('[data-screen="introduction"]').getByRole("heading", {
      level: 1,
      name: "A private home for your skills.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("main h1")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close sign in" }).click();
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Accept invitation", exact: true }),
  ).toBeVisible();
  expect(reads).toEqual([]);
});
test("signed-in entry and account sign-out react to session changes", async ({
  page,
}) => {
  const reads = await privateReads(page);
  await page.goto("/");
  await session(page, "user_fixture");
  await expect(
    page.getByRole("heading", { name: "Your private library" }),
  ).toBeVisible();
  await page
    .locator(".private-content")
    .evaluate((el) => el.setAttribute("data-old-session", "true"));
  await session(page, "user_fixture", "session_changed");
  await expect(page.locator("[data-old-session]")).toHaveCount(0);
  await page
    .locator(".private-content")
    .evaluate((el) => el.setAttribute("data-old-user", "true"));
  await session(page, "user_other", "session_other");
  await expect(page.locator("[data-old-user]")).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-clerk-session", {
        detail: { isLoaded: false, userId: null, sessionId: null },
      }),
    ),
  );
  await expect(
    page.getByRole("heading", { name: "Loading your library" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-component="status-card"]').getByRole("heading", {
      level: 1,
      name: "Loading your library",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".private-content")).toHaveCount(0);
  await session(page, "user_other", "session_other");
  await expect(
    page.getByRole("heading", { name: "Your private library" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/headjack-t2-evidence/signed-in-desktop-fixture.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "A private home for your skills." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your private library" }),
  ).toHaveCount(0);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(url => new URL(url).pathname === "/api/skills")).toBe(true);
});
test("desktop sidebar stays in view after the Ctrl/Cmd+B primitive shortcut", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const link = page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Library", exact: true });
  await expect(link).toBeInViewport();
  for (const key of ["Control+b", "Meta+b", "Control+b"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    await expect(link).toBeInViewport();
  }
});
test("mobile keyboard navigation sheet closes and returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Toggle navigation" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await page.screenshot({
    path: "/tmp/headjack-t2-evidence/mobile-sheet-fixture.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/headjack-t2-evidence/introduction-mobile-fixture.png",
    fullPage: true,
  });
});
test("premium introduction has one main, accessible skip link and no serious axe violations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("main")).toHaveCount(1);
  await page.screenshot({
    path: "/tmp/headjack-t2-evidence/introduction-desktop-fixture.png",
    fullPage: true,
  });
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
});

const mobileDestinations = [
  { name: "Overview", path: "/", heading: "Your private library" },
  { name: "Library", path: "/library", heading: "Your private library" },
  { name: "Updates", path: "/updates", heading: "Detected upstream changes" },
  { name: "Getting started", path: "/getting-started", heading: "Getting started" },
  { name: "Headjack", path: "/", heading: "Your private library" },
];
for (const destination of mobileDestinations) {
  test(`mobile ${destination.name} navigation closes the sheet and restores destination keyboard access`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/**", (route) => route.fulfill({
      json: { skills: [], total: 0, limit: 24, offset: 0, updates: [] },
    }));
    await page.goto(destination.path === "/library" ? "/getting-started" : "/library");
    await session(page, "user_fixture");
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    const dialog = page.getByRole("dialog", { name: "Navigation" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("link", { name: destination.name, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${fixtureOrigin}${destination.path}`);
    await expect(page.locator("main h1")).toHaveText(destination.heading);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: destination.heading, exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).pointerEvents)).not.toBe("none");
    const main = page.getByRole("main");
    await main.focus();
    await page.keyboard.press("Tab");
    expect(await main.evaluate((element) => element.contains(document.activeElement) && document.activeElement?.matches("a,button,input,select,textarea"))).toBe(true);
    if (destination.path === "/getting-started") {
      await page.screenshot({ path: "/tmp/headjack-final-fix-mobile-nav-fixture.png", fullPage: true });
    }
  });
}

test("mobile current-route selection closes the sheet without changing the route", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await privateReads(page);
  await page.goto("/library");
  await session(page, "user_fixture");
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await dialog.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(`${fixtureOrigin}/library`);
  await expect(dialog).toHaveCount(0);
});

test("mobile modified navigation opens a new tab and keeps the current sheet open", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await privateReads(page);
  await page.goto("/library");
  await session(page, "user_fixture");
  await expect(page.getByRole("heading", { name: "Your private library", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  const newPage = context.waitForEvent("page");
  await dialog.getByRole("link", { name: "Getting started", exact: true }).click({ modifiers: ["ControlOrMeta"] });
  const destination = await newPage;
  await destination.waitForURL(`${fixtureOrigin}/getting-started`, { waitUntil: "domcontentloaded" });
  await expect(destination).toHaveURL(`${fixtureOrigin}/getting-started`);
  await expect(page).toHaveURL(`${fixtureOrigin}/library`);
  await expect(dialog).toBeVisible();
  await destination.close();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("desktop route selection preserves expanded sidebar navigation", async ({ page }) => {
  await privateReads(page);
  await page.goto("/library");
  await session(page, "user_fixture");
  const sidebar = page.locator('[data-slot="sidebar"][data-state]');
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "Getting started", exact: true }).click();
  await expect(page).toHaveURL(`${fixtureOrigin}/getting-started`);
  await expect(page.getByRole("heading", { level: 1, name: "Getting started", exact: true })).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
});

test("a dark OS colour scheme keeps the light paper controls", async ({ page }) => {
  await privateReads(page);
  const paint = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color, style.borderColor];
    });
  const bodyBackground = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true }).last();
  await expect(signIn).toBeVisible();
  const lightButton = await paint(signIn);
  expect(await bodyBackground()).toBe("rgb(246, 242, 234)");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await paint(signIn)).toEqual(lightButton);
  expect(await bodyBackground()).toBe("rgb(246, 242, 234)");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/library");
  await session(page, "user_fixture");
  const search = page.getByLabel("Search skills", { exact: true });
  await expect(search).toBeVisible();
  const lightInput = await paint(search);
  expect(await bodyBackground()).toBe("rgb(246, 242, 234)");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await paint(search)).toEqual(lightInput);
  expect(await bodyBackground()).toBe("rgb(246, 242, 234)");
});

test("the workspace sidebar is the new shell", async ({ page }) => {
  await privateReads(page);
  await page.goto("/library");
  await session(page, "user_fixture");
  await expect(
    page.locator('[data-slot="sidebar"][data-state="expanded"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-slot="sidebar"] [data-component="shell"]'),
  ).toHaveCount(1);
});

test("the brand link shows the outlined mark and the text Headjack, with no wordmark request", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  await privateReads(page);
  await page.goto("/library");
  await session(page, "user_fixture");
  const brand = page.getByRole("navigation", { name: "Home" }).getByRole("link", { name: "Headjack", exact: true });
  await expect(brand).toHaveAttribute("href", "/");
  await expect(brand).toHaveText("Headjack");
  await expect(brand.locator('img[src="/brand/mark.svg"]')).toHaveAttribute("alt", "");
  const loaded = await brand.locator('img[src="/brand/mark.svg"]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(loaded, "the mark renders").toBe(true);
  expect(requested).not.toContain("/brand/wordmark.svg");
});

const routeHeadings = [
  { path: "/", heading: "Your private library" },
  { path: "/library", heading: "Your private library" },
  { path: "/updates", heading: "Detected upstream changes" },
  { path: "/getting-started", heading: "Getting started" },
];
for (const route of routeHeadings) {
  test(`${route.path} has exactly one level-one heading in main`, async ({ page }) => {
    await page.route("**/api/**", (request) => request.fulfill({
      json: { skills: [], total: 0, limit: 24, offset: 0, updates: [] },
    }));
    await page.goto(route.path);
    await session(page, "user_fixture");
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1, name: route.heading, exact: true }),
    ).toBeVisible();
    await expect(page.locator("main h1")).toHaveCount(1);
  });
}
