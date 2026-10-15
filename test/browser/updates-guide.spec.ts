import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { session } from "./library-fixtures";

const update = (extra = {}) => ({
  slug: "methodology@marketplace:skill's-name",
  name: "A changed repository",
  current_commit: "a".repeat(40),
  reviewed_commit: "b".repeat(40),
  latest_commit: "c".repeat(40),
  checked_at: "2026-10-05T12:00:00Z",
  source_url: "https://example.com/repository",
  source_path: "skills/your-skill",
  ...extra,
});
async function open(page: Page, path = "/updates") {
  await page.goto(path);
  await session(page);
}
async function fixture(page: Page, updates = [update()]) {
  await page.route("**/api/updates*", (route) => route.fulfill({ json: { updates } }));
}

test("updates exposes repository-level detection, real commit baselines and encoded detail/source links", async ({ page }) => {
  const paths: string[] = [];
  await page.route("**/api/updates*", (route) => {
    paths.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ json: { updates: [update()] } });
  });
  await open(page);
  await expect(page.getByRole("heading", { level: 1, name: "Detected upstream changes" })).toBeVisible();
  await expect(page.getByText(/Detection is repository-level/)).toBeVisible();
  await expect(page.getByRole("link", { name: "A changed repository" })).toHaveAttribute("href", `/skills/${encodeURIComponent(update().slug)}`);
  await expect(page.getByRole("link", { name: "https://example.com/repository", exact: true })).toHaveAttribute("rel", "noopener noreferrer");
  for (const commit of [update().current_commit, update().reviewed_commit, update().latest_commit])
    await expect(page.getByText(commit, { exact: true })).toBeVisible();
  await expect(page.getByText("Latest reviewed commit", { exact: true })).toBeVisible();
  await expect(page.locator("time")).toHaveAttribute("datetime", update().checked_at);
  await expect(page.locator("time")).toContainText("October 5, 2026");
  await expect(page.locator("time")).toContainText("UTC");
  await expect(page.getByText(update().source_path, { exact: true })).toBeVisible();
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path === "/api/updates")).toBe(true);
  await expect(page.getByRole("button", { name: /Publish|Update now|Review now/i })).toHaveCount(0);
});

test("updates shows the detection note as a complementary region and one Last checked time per row", async ({ page }) => {
  await fixture(page);
  await open(page);
  await expect(page.getByRole("link", { name: "A changed repository" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "About upstream detection" })).toBeVisible();
  await expect(page.locator("time")).toHaveCount(1);
});

test("no detected updates stays truthful and provides working library navigation", async ({ page }) => {
  await fixture(page, []);
  await open(page);
  await expect(page.getByText("No upstream changes detected.", { exact: true })).toBeVisible();
  await expect(page.getByText(/does not verify that every skill is unchanged/)).toBeVisible();
  await page.route("**/api/skills?*", (route) => route.fulfill({ json: { skills: [], total: 0, limit: 24, offset: 0 } }));
  await page.getByRole("link", { name: "Browse library", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
});

test("updates loading and recoverable errors keep a functional retry", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let retry = false;
  await page.route("**/api/updates*", async (route) => {
    await gate;
    return route.fulfill(retry ? { json: { updates: [update()] } } : { status: 503, json: { error: "unavailable" } });
  });
  await open(page);
  await expect(page.getByText("Checking detected upstream changes…", { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("status").filter({ hasText: "Checking detected upstream changes…" })).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Unable to load");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Unable to load upstream updates. Try again.");
  retry = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("link", { name: "A changed repository" })).toBeVisible();
});

test("current updates 401 expires private presentation", async ({ page }) => {
  await page.route("**/api/updates*", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await open(page);
  await expect(page.getByText(/Your session expired/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Detected upstream changes" })).toHaveCount(0);
});

test("updates 403 presents resource access denial", async ({ page }) => {
  await page.route("**/api/updates*", (route) => route.fulfill({ status: 403, json: { error: "forbidden" } }));
  await open(page);
  await expect(page.getByRole("heading", { name: "Access unavailable" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("status").filter({ hasText: "Access unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("unsafe upstream links and remote markup stay selectable inert text", async ({ page }) => {
  const text = "<script>window.updatesExecuted=true</script>";
  await fixture(page, [update({ name: text, source_path: text, source_url: "javascript:alert(1)" }), update({ slug: "other", name: "Other", source_url: "data:text/html,hello" })]);
  await open(page);
  await expect(page.getByText("javascript:alert(1)", { exact: true })).toBeVisible();
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(page.locator('main script, a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).updatesExecuted)).toBeUndefined();
});

test("updates clears prior-owner rows and aborts old reads on account change", async ({ page }) => {
  await fixture(page);
  await open(page);
  await expect(page.getByRole("link", { name: "A changed repository" })).toBeVisible();
  let release!: () => void;
  let terminal!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { terminal = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/updates*", async (route) => {
    started();
    await gate;
    try { await route.fulfill({ json: { updates: [update({ name: "Stale owner row" })] } }); } catch {} finally { terminal(); }
  });
  await session(page, "owner_b", "session_b");
  await requestStarted;
  await expect(page.getByText("Checking detected upstream changes…")).toBeVisible();
  await expect(page.getByRole("link", { name: "A changed repository" })).toHaveCount(0);
  await fixture(page, [update({ name: "Current owner row" })]);
  await session(page, "owner_c", "session_c");
  await expect(page.getByRole("link", { name: "Current owner row" })).toBeVisible();
  release();
  await finished;
  await expect(page.getByRole("link", { name: "Stale owner row" })).toHaveCount(0);
});

test("Getting started uses real selectable CLI commands and truthful workflow boundaries", async ({ page }) => {
  await open(page, "/getting-started");
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  const commands = ["headjack harness detect", 'headjack search --purpose manual -- "render a video with remotion"', "headjack add -- 'your-skill'", "headjack list --json", "headjack verify", "headjack updates", "headjack review --path 'skills/your-skill' --slug 'your-skill' -- 'https://github.com/owner/repository'", "headjack import --dry-run"];
  for (const command of commands) await expect(page.locator("code").filter({ hasText: command }).first()).toBeVisible();
  await expect(page.getByText(/Downloading an archive does not install/)).toBeVisible();
  await expect(page.getByText(/Access is restricted/)).toBeVisible();
  await expect(page.getByText(/OAuth login is still pending/)).toHaveCount(0);
  await expect(page.getByText(/sign in from the CLI with your browser/i)).toBeVisible();
  for (const command of ["headjack login", "headjack whoami", "headjack logout"]) await expect(page.locator("code").filter({ hasText: new RegExp(`^${command}$`) }).first()).toBeVisible();
  await expect(page.getByText(/read-only MCP server/i)).toBeVisible();
  await expect(page.getByText(/HEADJACK_TOKEN/)).toBeVisible();
  await expect(page.locator("code").filter({ hasText: /npm install|claude mcp|client-id|<[^>]*client id|sk_live_|sk_test_/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Publish|Connect MCP|Log in to CLI/ })).toHaveCount(0);
});

test("guide copy succeeds, retains keyboard focus and reports permission fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedCommand = text; } } });
  });
  await open(page, "/getting-started");
  const button = page.getByRole("button", { name: "Copy search command", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Command copied." })).toBeVisible();
  await expect(button).toBeFocused();
  expect(await page.evaluate(() => (window as any).copiedCommand)).toBe('headjack search --purpose manual -- "render a video with remotion"');
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "Clipboard unavailable" })).toBeVisible();
  await expect(page.locator("code").filter({ hasText: 'headjack search --purpose manual -- "render a video with remotion"' })).toHaveCSS("user-select", "text");
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedCommand = text; } } }); });
  for (const group of await page.locator(".guide-command").all()) {
    const visibleCommand = await group.locator("code").textContent();
    await group.getByRole("button").click();
    await expect.poll(() => page.evaluate(() => (window as any).copiedCommand)).toBe(visibleCommand);
    await expect(group.getByRole("status")).toHaveText("Command copied.");
  }
});

test("guide copy button shows a visible keyboard focus ring", async ({ page }) => {
  await open(page, "/getting-started");
  const button = page.getByRole("button", { name: "Copy search command", exact: true });
  const ring = () =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} | ${style.boxShadow}`;
    });
  // Reads the ring once it has stopped transitioning.
  const settled = async () => {
    let previous = "";
    await expect.poll(async () => {
      const current = await ring();
      const stable = current === previous;
      previous = current;
      return stable;
    }).toBe(true);
    return previous;
  };
  await page.locator("#find").focus();
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  const focused = await settled();
  await button.evaluate((element) => (element as HTMLElement).blur());
  await expect(button).not.toBeFocused();
  expect(await settled()).not.toBe(focused);
});

test("new shell links navigate and mark the current page", async ({ page }) => {
  await fixture(page, []);
  await open(page, "/getting-started");
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await expect(nav.getByRole("link", { name: "Getting started" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Updates", exact: true }).click();
  await expect(page.getByText("No upstream changes detected.", { exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Updates", exact: true })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Getting started" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  for (const target of ["#access", "#find", "#install", "#review"]) {
    await page.getByRole("navigation", { name: "Getting started sections" }).locator(`a[href="${target}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(page.locator(target).getByRole("heading")).toBeInViewport();
    await expect(page.locator(target)).toBeFocused();
  }
  await page.goBack();
  await expect(page).toHaveURL(/#install$/);
  await expect(page.locator("#install").getByRole("heading")).toBeInViewport();
  await expect(page.locator("#install")).toBeFocused();
  await page.getByRole("navigation", { name: "Guide next steps" }).getByRole("link", { name: "Detected upstream changes", exact: true }).click();
  await expect(page.getByText("No upstream changes detected.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Review with the CLI", exact: true }).click();
  await expect(page).toHaveURL(/\/getting-started#review$/);
  await expect(page.locator("#review").getByRole("heading")).toBeInViewport();
  await expect(page.locator("#review")).toBeFocused();
  await page.route("**/api/skills?*", (route) => route.fulfill({ json: { skills: [], total: 0, limit: 24, offset: 0 } }));
  await page.getByRole("navigation", { name: "Guide next steps" }).getByRole("link", { name: "Browse library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your private library", exact: true })).toBeVisible();
});

test("guide rail clicks move focus in place without a session recheck or remount", async ({ page }) => {
  await open(page, "/getting-started");
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  // Record any "Rechecking your session…" render and mark the page's own heading node to detect a remount.
  await page.evaluate(() => {
    const w = window as any;
    w.__rechecked = false;
    w.__heading = document.querySelector("h1");
    new MutationObserver(() => {
      if (document.body.textContent?.includes("Rechecking your session")) w.__rechecked = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const rail = page.getByRole("navigation", { name: "Getting started sections" });
  for (const target of ["#find", "#install", "#review"]) {
    await rail.locator(`a[href="${target}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(page.locator(target)).toBeFocused();
    await expect(page.locator(target).getByRole("heading")).toBeInViewport();
  }
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__rechecked)).toBe(false);
  expect(await page.evaluate(() => (window as any).__heading === document.querySelector("h1"))).toBe(true);
  // Real Back still rechecks the session, as the auth boundary requires, and lands on the previous section.
  await page.goBack();
  await expect(page).toHaveURL(/#install$/);
  await expect(page.locator("#install")).toBeFocused();
});

test("guide direct hash landing restores only a known section after sign-in", async ({ page }) => {
  await open(page, "/getting-started#install");
  await expect(page.locator("#install").getByRole("heading")).toBeInViewport();
  await expect(page.locator("#install")).toBeFocused();
  await open(page, "/getting-started#not-a-guide-section");
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  for (const target of ["#access", "#find", "#install", "#review"])
    await expect(page.locator(target)).not.toBeFocused();
});

for (const path of ["/updates", "/getting-started"]) {
  test(`${path} remains accessible and contained at mobile width`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, path);
    await expect(page.getByRole("heading", { level: 1, name: path === "/updates" ? "Detected upstream changes" : "Getting started", exact: true })).toBeVisible();
    if (path === "/updates") await expect(page.getByRole("link", { name: "A changed repository" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    await page.screenshot({ path: `/tmp/headjack-t5-${path.slice(1)}-mobile-fixture.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `/tmp/headjack-t5-${path.slice(1)}-desktop-fixture.png`, fullPage: true });
  });
}
