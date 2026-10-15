import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { row, session, openLibrary, deferredReads, releaseReads, fixtureScreenshot, fitsViewport, browseRows } from "./library-fixtures";
test("real browse total, grid/list URL persistence, manual page and filter resets", async ({
  page,
}) => {
  const requests: URL[] = [];
  await page.route("**/api/skills?*", (route) => {
    const u = new URL(route.request().url());
    requests.push(u);
    return route.fulfill({
      json: {
        skills: [row()],
        total: 52,
        limit: 24,
        offset: Number(u.searchParams.get("offset")),
      },
    });
  });
  await openLibrary(page);
  await expect(page.getByText("52 skills in this view")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Alpha skill", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/headjack-t3-library-desktop.png",
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/headjack-t3-library-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/offset=24/);
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page).toHaveURL(/view=list&offset=24/);
  await page.getByLabel("Kind", { exact: true }).selectOption("plugin");
  await expect(page).toHaveURL(/kind=plugin&view=list$/);
  await page.getByLabel("Add tag", { exact: true }).fill("Front_End");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await expect(page).toHaveURL(/tag=front-end/);
  await expect(
    page.getByRole("button", { name: "Remove tag front-end" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Remove tag front-end" }),
  ).toHaveCount(0);
  await page.reload();
  await session(page);
  await expect(page.getByRole("table")).toBeVisible();
  expect(requests.every((u) => u.searchParams.get("limit") === "24")).toBe(
    true,
  );
});
test("submitted capped search uses manual purpose, approved-only availability and retains focus", async ({
  page,
}) => {
  await page.route("**/api/skills?*", (route) =>
    route.fulfill({
      json: {
        skills: [row("Rejected skill", { has_approved_version: false })],
        total: 1,
        limit: 24,
        offset: 0,
      },
    }),
  );
  const searchRequests: {
    url: string;
    purpose: string | undefined;
    auth: string | undefined;
  }[] = [];
  await page.route("**/api/search?*", (route) => {
    const r = route.request();
    searchRequests.push({
      url: r.url(),
      purpose: r.headers()["x-headjack-purpose"],
      auth: r.headers()["authorization"],
    });
    const { quality, has_approved_version, ...skill } = row("Search skill");
    return route.fulfill({
      json: {
        results: [
          {
            ...skill,
            score: 0.2,
            fts_rank: 1,
            vector_rank: null,
            similarity: null,
            matched: "fts",
            variant: "rrf-english",
            alternatives: ["other-skill"],
          },
        ],
      },
    });
  });
  await openLibrary(page);
  await expect(
    page.getByRole("button", { name: "Install unavailable" }),
  ).toBeDisabled();
  const input = page.getByLabel("Search skills", { exact: true });
  await input.fill("search");
  expect(searchRequests).toHaveLength(0);
  await input.press("Enter");
  await expect(page.getByText("Up to 25 matching skills")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Search skill", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Approved version available")).toBeVisible();
  await expect(page.getByText("Alternatives: other-skill")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);
  await expect(input).toBeFocused();
  await fixtureScreenshot(page, "manual-search-results");
  expect(searchRequests[0].purpose).toBe("manual");
  expect(searchRequests[0].auth).toBeUndefined();
  expect(new URL(searchRequests[0].url).searchParams.get("k")).toBe("25");
  await expect(
    page.getByText("Useful <script>remote text</script>"),
  ).toBeVisible();
  await expect(
    page.locator("script").filter({ hasText: "remote text" }),
  ).toHaveCount(0);
});
for (const status of [200, 401])
  test(`late superseded query ${status} cannot overwrite or expire the fast query`, async ({ page }) => {
    await deferredReads(page, "/api/search?q=slow");
    await page.route("**/api/skills?*", (route) => route.fulfill({ json: { skills: [], total: 0, limit: 24, offset: 0 } }));
    const result = (name: string) => ({ results: [{ ...row(name), score: 1, fts_rank: 1,
      vector_rank: null, similarity: null, matched: "fts", variant: "rrf-english" }] });
    await page.route("**/api/search?*", (route) => route.fulfill({json: result("Fast query")}));
    await openLibrary(page);
    const input = page.getByLabel("Search skills", { exact: true });
    await input.fill("slow"); await input.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).deferredRead.started)).toBeGreaterThan(0);
    if (status === 200) await fixtureScreenshot(page, "library-loading");
    await input.fill("fast"); await input.press("Enter");
    await expect(page.getByRole("link", {name: "Fast query", exact: true})).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).deferredRead.aborted)).toBeGreaterThan(0);
    await releaseReads(page, status, status === 200 ? result("Old query") : {error: {message: "Expired old query"}});
    await expect(page.getByRole("link", {name: "Old query", exact: true})).toHaveCount(0);
    await expect(page.getByRole("link", {name: "Fast query", exact: true})).toBeVisible();
    expect(await page.evaluate(() => (window as any).deferredRead.expired)).toBe(0);
  });
test("empty vault differs from no matches and invalid URL can be reset", async ({
  page,
}) => {
  await page.route("**/api/skills?*", (route) =>
    route.fulfill({ json: { skills: [], total: 0, limit: 24, offset: 0 } }),
  );
  await openLibrary(page);
  await expect(
    page.getByText("Your vault is empty. Add a skill with the CLI to begin."),
  ).toBeVisible();
  await fixtureScreenshot(page, "empty-library");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.getByLabel("Kind", { exact: true }).selectOption("plugin");
  await expect(page.getByText("No skills match these filters.")).toBeVisible();
  await expect(
    page.getByRole("main").locator('[data-component="status-card"]'),
  ).toHaveAttribute("role", "status");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.goto("/library?kind=bad");
  await session(page);
  await expect(
    page.getByText("Invalid kind. Choose skill or plugin."),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("alert"),
  ).toContainText("Invalid kind. Choose skill or plugin.");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(
    page.getByText("Your vault is empty. Add a skill with the CLI to begin."),
  ).toBeVisible();
});
test("Reset filters clears unsubmitted search and tag drafts even when the URL is already default", async ({
  page,
}) => {
  await browseRows(page, [row()]);
  await openLibrary(page);
  await expect(page.getByRole("link", { name: "Alpha skill", exact: true })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search skills" });
  const tag = page.getByRole("textbox", { name: "Add tag" });
  await search.fill("unsubmitted query");
  await tag.fill("unsubmitted-tag");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(search).toHaveValue("");
  await expect(tag).toHaveValue("");
  await expect(page).toHaveURL(/\/library$/);
});
for (const [status, message] of [
  [403, "Admission required"],
  [500, "Temporary failure"],
  [200, "malformed"],
] as const) {
  test(`recoverable ${status} ${message} response retries`, async ({
    page,
  }) => {
    let retry = false;
    await page.route("**/api/skills?*", (route) =>
      route.fulfill(
        retry
          ? { json: { skills: [row()], total: 1, limit: 24, offset: 0 } }
          : message === "malformed"
            ? {
                status,
                body: '{"skills":false}',
                contentType: "application/json",
              }
            : { status, json: { error: { code: "failure", message } } },
      ),
    );
    await openLibrary(page);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    retry = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("link", { name: "Alpha skill", exact: true }),
    ).toBeVisible();
  });
}
test("out-of-range browse page retains total and offers an accurate reset", async ({
  page,
}) => {
  await page.route("**/api/skills?*", (route) =>
    route.fulfill({ json: { skills: [], total: 52, limit: 24, offset: 999 } }),
  );
  await openLibrary(page, "/library?offset=999");
  await expect(page.getByText("52 skills in this view")).toBeVisible();
  await expect(
    page.getByText(
      "No skills on this page. Reset filters to return to the first page.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reset filters" }),
  ).toBeVisible();
});


test("internal library failures use unavailable copy and preserve retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/skills?*", (route) => route.fulfill(fail
    ? { status: 500, json: {error: {message: "internal error: private backend /server/provider"}} }
    : {json: {skills: [row()], total: 1, limit: 24, offset: 0}}));
  await openLibrary(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("This content is temporarily unavailable. Try again in a moment.");
  await expect(page.getByText(/private backend|server\/provider|internal error/)).toHaveCount(0);
  await fixtureScreenshot(page, "library-error");
  fail = false; await page.getByRole("button", {name: "Try again"}).click();
  await expect(page.getByRole("link", {name: "Alpha skill", exact: true})).toBeVisible();
});

test("workspace brand belongs to a named landmark", async ({ page }) => {
  await page.route("**/api/skills?*", (route) => route.fulfill({json: {skills: [], total: 0, limit: 24, offset: 0}}));
  await openLibrary(page);
  await expect(page.getByText("Your vault is empty. Add a skill with the CLI to begin.")).toBeVisible();
  const result = await new AxeBuilder({page}).withRules(["region"]).analyze();
  expect(result.violations).toEqual([]);
});

const cards = (page: Page) => page.locator('[data-component="skill-card"]');
const libraryCard = (page: Page) =>
  page.getByRole("main").locator('[data-component="status-card"]');

test("300-character names, slugs and descriptions wrap without horizontal scroll", async ({ page }) => {
  const long = (letter: string) => letter.repeat(300);
  await browseRows(page, [
    row(long("N"), { slug: long("s"), description: long("d"), plugin_slug: long("p") }),
  ]);
  for (const [width, height] of [[390, 844], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await openLibrary(page);
    await expect(page.getByRole("link", { name: long("N"), exact: true })).toBeVisible();
    expect(await fitsViewport(page)).toBe(true);
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("table", { name: "Library skills" })).toBeVisible();
    expect(await fitsViewport(page)).toBe(true);
  }
});

test("eight active tag chips wrap and stay removable at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await browseRows(page, [row()]);
  await openLibrary(page);
  const tags = Array.from({ length: 8 }, (_, i) => `frontend-architecture-${i + 1}`);
  const field = page.getByLabel("Add tag", { exact: true });
  for (const tag of tags) {
    await field.fill(tag);
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await expect(page.getByRole("button", { name: `Remove tag ${tag}`, exact: true })).toBeVisible();
  }
  for (const tag of tags) {
    const chip = page.getByRole("button", { name: `Remove tag ${tag}`, exact: true });
    await expect(chip).toBeVisible();
    const box = await chip.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  }
  expect(await fitsViewport(page)).toBe(true);
  await page.getByRole("button", { name: "Remove tag frontend-architecture-8", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove tag frontend-architecture-8", exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/frontend-architecture-8/);
});

test("at 1024 px the card grid follows the content width with two columns", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await browseRows(page, ["Alpha skill", "Beta skill", "Gamma skill", "Delta skill"].map((name) => row(name)));
  await openLibrary(page);
  await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toHaveCount(1);
  await expect(cards(page)).toHaveCount(4);
  const tops = await cards(page).evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).offsetTop),
  );
  expect(tops.filter((top) => top === tops[0])).toHaveLength(2);
  expect(await fitsViewport(page)).toBe(true);
});

test("Grid view shows a visible keyboard focus indicator", async ({ page }) => {
  await browseRows(page, [row()]);
  await openLibrary(page);
  const grid = page.getByRole("button", { name: "Grid view", exact: true });
  await expect(grid).toBeVisible();
  const ring = () =>
    grid.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} | ${style.boxShadow}`;
    });
  const resting = await ring();
  await page.getByRole("button", { name: "Reset filters" }).focus();
  await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();
  await expect.poll(ring).not.toBe(resting);
  const focused = await ring();
  await grid.evaluate((element) => (element as HTMLElement).blur());
  await expect.poll(ring).not.toBe(focused);
});

test("each grid card holds one decorative icon tile", async ({ page }) => {
  await browseRows(page, [
    row("Alpha skill"),
    row("Beta plugin", { kind: "plugin" }),
    row("Gamma part", { plugin_slug: "beta-plugin" }),
  ]);
  await openLibrary(page);
  await expect(cards(page)).toHaveCount(3);
  for (const card of await cards(page).all()) {
    const tile = card.locator("[data-tint]");
    await expect(tile).toHaveCount(1);
    await expect(tile).toHaveAttribute("aria-hidden", "true");
  }
});

test("library status cards announce loading, errors and the empty vault with their roles", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let fail = true;
  await page.route("**/api/skills?*", async (route) => {
    if (!fail) return route.fulfill({ json: { skills: [], total: 0, limit: 24, offset: 0 } });
    await hold;
    return route.fulfill({ status: 500, json: { error: { message: "failure" } } });
  });
  await openLibrary(page);
  const card = libraryCard(page);
  await expect(card).toContainText("Reading your skills…");
  await expect(card).toHaveAttribute("role", "status");
  await expect(card).toHaveAttribute("aria-busy", "true");
  release();
  await expect(card).toHaveAttribute("role", "alert");
  await expect(card).not.toHaveAttribute("aria-busy");
  fail = false;
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card).toContainText("Your vault is empty. Add a skill with the CLI to begin.");
  await expect(card).toHaveAttribute("role", "status");
  await expect(card).not.toHaveAttribute("aria-busy");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});
