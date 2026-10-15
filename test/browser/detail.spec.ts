import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { session, row, fixtureScreenshot } from "./library-fixtures";
const hash = "a".repeat(64);
const hostile = "<script>window.detailExecuted=true</script>";
const skill = (extra = {}) => ({
  ...row("Detail skill"),
  source_kind: "github",
  source_url: "https://example.com/repository",
  default_ref: "main",
  source_path: "skills/detail",
  commit_sha: "b".repeat(40),
  sha256: hash,
  size: 128,
  reviewed_at: "2026-10-05T12:00:00Z",
  review_notes: hostile,
  scan_flags: ["manual check"],
  latest_commit: "c".repeat(40),
  ...extra,
});
const version = (extra = {}) => ({
  id: 1,
  commit_sha: "b".repeat(40),
  sha256: hash,
  size: 128,
  status: "approved",
  reviewed_at: "2026-10-05T12:00:00Z",
  review_notes: hostile,
  scan_flags: ["manual check"],
  current: true,
  ...extra,
});
const review = (extra = {}) => {
  const { id, size, scan_flags, ...record } = version(extra);
  return record;
};
async function fixtures(
  page: Page,
  record = skill(),
  versions = [version()],
  reviews = [review()],
) {
  await page.route("**/api/skills/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/download"))
      return route.fulfill({
        body: "archive bytes",
        contentType: "application/gzip",
        headers: { "x-skill-sha256": hash },
      });
    if (url.pathname.endsWith("/versions"))
      return route.fulfill({ json: { versions } });
    if (url.pathname.endsWith("/reviews"))
      return route.fulfill({ json: { reviews } });
    return route.fulfill({ json: { skill: record } });
  });
}
async function open(page: Page, slug = "detail-skill") {
  await page.goto(`/skills/${encodeURIComponent(slug)}`);
  await session(page);
}
async function ready(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Detail skill", exact: true }),
  ).toBeVisible();
}

test("detail preserves inert selectable provenance/review text and actual content hashes", async ({
  page,
}) => {
  await fixtures(
    page,
    skill({ source_path: hostile, source_url: "javascript:alert(1)" }),
  );
  await open(page);
  await ready(page);
  await expect(page.getByText(hostile, { exact: true }).first()).toBeVisible();
  await expect(page.locator("article script")).toHaveCount(0);
  await expect(
    page.locator('a[href^="javascript:"],a[href^="data:"]'),
  ).toHaveCount(0);
  await expect(
    page.getByText("Content SHA-256", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(hash, { exact: true }).first()).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).detailExecuted),
  ).toBeUndefined();
  await expect(page.getByText(/Verified|Reviewed by John Doe/)).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "/tmp/headjack-t4-desktop-fixture.png",
    fullPage: true,
  });
});

test("HTTP source links remain usable and data URLs stay plain text", async ({
  page,
}) => {
  await fixtures(page);
  await open(page);
  await ready(page);
  await expect(
    page.getByRole("link", {
      name: "https://example.com/repository",
      exact: true,
    }),
  ).toHaveAttribute("href", "https://example.com/repository");
  await fixtures(page, skill({ source_url: "data:text/html,hello" }));
  await page.reload();
  await session(page);
  await ready(page);
  await expect(
    page.getByText("data:text/html,hello", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('a[href^="data:"]')).toHaveCount(0);
});

test("encodes colon/marketplace slug for all independent API endpoints", async ({
  page,
}) => {
  const requests: string[] = [];
  await fixtures(
    page,
    skill({
      slug: "plug@market:skill",
      plugin_slug: "plug@market",
      size: null,
    }),
  );
  page.on("request", (req) => {
    if (req.url().includes("/api/skills/"))
      requests.push(new URL(req.url()).pathname);
  });
  await open(page, "plug@market:skill");
  await ready(page);
  await expect
    .poll(() => [...new Set(requests)].sort())
    .toEqual([
      "/api/skills/plug%40market%3Askill",
      "/api/skills/plug%40market%3Askill/reviews",
      "/api/skills/plug%40market%3Askill/versions",
    ]);
  await expect(
    page.getByText("headjack add -- 'plug@market:skill'", { exact: true }),
  ).toBeVisible();
});

test("rejected-only detail disables install and archive while showing rejected history", async ({
  page,
}) => {
  await fixtures(
    page,
    skill({
      sha256: null,
      size: null,
      reviewed_at: null,
      review_notes: null,
      scan_flags: null,
    }),
    [version({ status: "rejected", current: false })],
    [review({ status: "rejected", current: false })],
  );
  await open(page);
  await ready(page);
  await expect(
    page.getByText("No approved version", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy command" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Download archive" }),
  ).toBeDisabled();
  await expect(
    page.getByText("rejected", { exact: true }).first(),
  ).toBeVisible();
  await fixtureScreenshot(page, "rejected-only-detail");
  await expect(
    page.getByText("headjack add -- 'detail-skill'", { exact: true }),
  ).toHaveCount(0);
});
for (const [kind, plugin_slug] of [
  ["plugin", null],
  ["skill", "plug@market"],
] as const)
  test(`${kind} ${plugin_slug ?? ""} explains plugin workflow and never downloads`, async ({
    page,
  }) => {
    await fixtures(page, skill({ kind, plugin_slug, size: null }));
    await open(page);
    await ready(page);
    await expect(
      page.getByText(/enables the plugin in Claude settings/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy command" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Download archive" }),
    ).toBeDisabled();
    if (plugin_slug)
      await expect(
        page.getByRole("link", { name: plugin_slug, exact: true }),
      ).toHaveAttribute("href", "/skills/plug%40market");
  });

test("missing provenance and empty histories are explicit", async ({
  page,
}) => {
  await fixtures(
    page,
    skill({
      source_kind: null,
      source_url: null,
      default_ref: null,
      source_path: null,
      commit_sha: null,
      quality: null,
      review_notes: null,
      scan_flags: null,
      reviewed_at: null,
    }),
    [],
    [],
  );
  await open(page);
  await ready(page);
  await expect(
    page.getByText("Not recorded", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("No version history recorded.")).toBeVisible();
  await expect(page.getByText("No review history recorded.")).toBeVisible();
});

test("partial history failure keeps detail and other history; retry only failed history", async ({
  page,
}) => {
  await fixtures(page);
  let failed = true;
  let detailReads = 0;
  let versionReads = 0;
  page.on("request", (req) => {
    const p = new URL(req.url()).pathname;
    if (p === "/api/skills/detail-skill") ++detailReads;
    if (p.endsWith("/versions")) ++versionReads;
  });
  await page.route("**/api/skills/*/reviews", (route) =>
    route.fulfill(
      failed
        ? {
            status: 500,
            json: {
              error: { message: "Review history temporarily unavailable" },
            },
          }
        : { json: { reviews: [review()] } },
    ),
  );
  await open(page);
  await ready(page);
  const reviews = page.getByRole("region", {
    name: "Review history",
    exact: true,
  });
  await expect(
    reviews.getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Version history", exact: true })
      .getByText(hash, { exact: true }),
  ).toBeVisible();
  await fixtureScreenshot(page, "partial-history-failure");
  const counts = [detailReads, versionReads];
  failed = false;
  await reviews.getByRole("button", { name: "Try again" }).click();
  await expect(reviews.getByText(hostile, { exact: true })).toBeVisible();
  expect([detailReads, versionReads]).toEqual(counts);
});

test("main detail failure retries independently without refetching histories", async ({
  page,
}) => {
  await fixtures(page);
  let fail = true;
  let histories = 0;
  page.on("request", (req) => {
    if (/\/(reviews|versions)$/.test(req.url())) ++histories;
  });
  await page.route("**/api/skills/detail-skill", (route) =>
    route.fulfill(
      fail
        ? {
            status: 500,
            json: { error: { message: "Temporary detail failure" } },
          }
        : { json: { skill: skill() } },
    ),
  );
  await open(page);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect.poll(() => histories).toBeGreaterThanOrEqual(2);
  const before = histories;
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await ready(page);
  expect(histories).toBe(before);
});

test("main 404 has owner-neutral not-found surface", async ({ page }) => {
  await fixtures(page);
  await page.route("**/api/skills/detail-skill", (route) =>
    route.fulfill({
      status: 404,
      json: { error: { message: "Other owner exists secret" } },
    }),
  );
  await open(page);
  await expect(
    page.getByRole("heading", { name: "Content not found" }),
  ).toBeVisible();
  await expect(page.getByText("Other owner exists secret")).toHaveCount(0);
});

test("clipboard denial retains selectable command and accessible feedback", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await fixtures(page, skill({ slug: "-leading" }));
  await open(page, "-leading");
  await ready(page);
  await page.getByRole("button", { name: "Copy command" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "select the command" }),
  ).toBeVisible();
  await expect(
    page.getByText("headjack add -- '-leading'", { exact: true }),
  ).toBeVisible();
  expect(
    await page
      .getByText("headjack add -- '-leading'", { exact: true })
      .evaluate((el) => getComputedStyle(el).userSelect),
  ).not.toBe("none");
});

test("clipboard success announces copied command and retains keyboard focus", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          (window as any).copied = text;
          return Promise.resolve();
        },
      },
    }),
  );
  await fixtures(page);
  await open(page);
  await ready(page);
  const copy = page.getByRole("button", { name: "Copy command" });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Command copied." }),
  ).toBeVisible();
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => (window as any).copied)).toBe(
    "headjack add -- 'detail-skill'",
  );
});

test("archive uses uncached cookies, safe filename, revoked blob and content-hash metadata", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, options) => {
      if (String(input).endsWith("/download"))
        (window as any).archiveOptions = {
          credentials: options?.credentials,
          cache: options?.cache,
        };
      return original(input, options);
    };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      const url = create(b);
      (window as any).created = url;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      (window as any).revoked = url;
      revoke(url);
    };
  });
  await fixtures(page, skill({ slug: "detail@market:skill" }));
  await open(page, "detail@market:skill");
  await ready(page);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download archive" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("detail_market_skill.tar.gz");
  expect(await page.evaluate(() => (window as any).archiveOptions)).toEqual({
    credentials: "same-origin",
    cache: "no-store",
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).revoked === (window as any).created),
    )
    .toBe(true);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Archive downloaded. Content SHA-256: ${hash}` }),
  ).toBeVisible();
  await expect(page.getByText(/does not install/)).toBeVisible();
});
for (const [status, message] of [
  [404, "Archive unavailable"],
  [409, "Archive unavailable"],
] as const)
  test(`archive ${status} visible and retryable`, async ({ page }) => {
    await fixtures(page);
    await page.route("**/api/skills/*/download", (route) =>
      route.fulfill({
        status,
        json: { error: { message: "Server authority" } },
      }),
    );
    await open(page);
    await ready(page);
    await page.getByRole("button", { name: "Download archive" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: message }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download archive" }),
    ).toBeEnabled();
  });
for (const endpoint of ["download", "reviews"])
  test(`current ${endpoint} 401 clears all private detail siblings`, async ({
    page,
  }) => {
    await fixtures(page);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await page.route(`**/api/skills/*/${endpoint}`, async (route) => {
      await hold;
      await route.fulfill({
        status: 401,
        json: { error: { message: "Expired" } },
      });
    });
    await open(page);
    await ready(page);
    if (endpoint === "download")
      await page.getByRole("button", { name: "Download archive" }).click();
    release();
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Detail skill", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(hash, { exact: true })).toHaveCount(0);
  });
for (const endpoint of ["download", "versions"])
  test(`current ${endpoint} 403 hides entire detail without claiming expiry`, async ({
    page,
  }) => {
    await fixtures(page);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await page.route(`**/api/skills/*/${endpoint}`, async (route) => {
      await hold;
      await route.fulfill({
        status: 403,
        json: { error: { message: "No access" } },
      });
    });
    await open(page);
    await ready(page);
    if (endpoint === "download")
      await page.getByRole("button", { name: "Download archive" }).click();
    release();
    await expect(
      page.getByRole("heading", { name: "Access unavailable" }),
    ).toBeVisible();
    await expect(page.getByText(hash, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Detail skill", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/session expired/)).toHaveCount(0);
  });
for (const status of [200, 401])
  test(`late archive ${status} cannot download or invalidate new session`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const original = window.fetch;
      (window as any).archiveStarted = false;
      (window as any).archiveTerminal = false;
      (window as any).expiredEvents = 0;
      window.addEventListener(
        "headjack-private-session-expired",
        () => ++(window as any).expiredEvents,
      );
      window.fetch = (input, options) => {
        if (!String(input).endsWith("/download"))
          return original(input, options);
        (window as any).archiveStarted = true;
        options?.signal?.addEventListener("abort", () => {
          (window as any).archiveAborted = true;
        });
        return new Promise<Response>((resolve) => {
          (window as any).releaseArchive = (status: number) => {
            resolve(
              new Response(
                status === 200 ? "archive" : '{"error":{"message":"Expired"}}',
                { status, headers: { "x-skill-sha256": "a".repeat(64) } },
              ),
            );
            setTimeout(() => {
              (window as any).archiveTerminal = true;
            }, 0);
          };
        });
      };
      URL.createObjectURL = () => {
        (window as any).downloadAttempt = true;
        return "blob:late";
      };
    });
    await fixtures(page);
    let ownerB = false;
    await page.route("**/api/skills/detail-skill", (route) =>
      route.fulfill({
        json: {
          skill: skill({ name: ownerB ? "Owner B skill" : "Detail skill" }),
        },
      }),
    );
    await open(page);
    await ready(page);
    await page.getByRole("button", { name: "Download archive" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).archiveStarted))
      .toBe(true);
    ownerB = true;
    await session(page, "owner_b", "session_b");
    // Wait for the new owner's actual record, not the old owner's identical heading.
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Owner B skill",
        exact: true,
      }),
    ).toBeVisible();
    await page.evaluate(
      (status) => (window as any).releaseArchive(status),
      status,
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).archiveTerminal))
      .toBe(true);
    expect(await page.evaluate(() => (window as any).archiveAborted)).toBe(
      true,
    );
    expect(
      await page.evaluate(() => (window as any).downloadAttempt),
    ).toBeUndefined();
    expect(await page.evaluate(() => (window as any).expiredEvents)).toBe(0);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Owner B skill",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/session expired/)).toHaveCount(0);
  });

test("every version history row holds exactly one scan-findings summary", async ({
  page,
}) => {
  await fixtures(page, skill(), [
    version(),
    version({ id: 2, scan_flags: [] }),
    version({ id: 3, scan_flags: null }),
  ]);
  await open(page);
  await ready(page);
  const history = page.getByRole("region", { name: "Version history", exact: true });
  const rows = history.locator("tbody > tr");
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++)
    await expect(rows.nth(i).locator("summary")).toHaveCount(1);
  await expect(history.locator("summary")).toHaveText([
    "1 scan finding",
    "No scan findings",
    "Scan findings not recorded",
  ]);
});

test("current review shows the current version's status, not a newer rejected review", async ({
  page,
}) => {
  const upstream = "d".repeat(64);
  await fixtures(
    page,
    skill(),
    [
      version({ id: 2, sha256: upstream, status: "rejected", current: false, reviewed_at: "2026-10-08T12:00:00Z" }),
      version(),
    ],
    [
      review({ sha256: upstream, status: "rejected", current: false, reviewed_at: "2026-10-08T12:00:00Z" }),
      review(),
    ],
  );
  await open(page);
  await ready(page);
  const current = page.getByRole("region", { name: "Current review", exact: true });
  await expect(current.getByText("Approved current version", { exact: true })).toBeVisible();
  await expect(current.getByText("approved", { exact: true })).toBeVisible();
  await expect(current.getByText("rejected", { exact: true })).toHaveCount(0);
});

test("detail uses two columns on wide content and puts the side card after the header on mobile", async ({
  page,
}) => {
  // 1440 leaves more than 1024 px of content beside the 16rem sidebar; 1280 does not.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixtures(page);
  await open(page);
  await ready(page);
  await expect(page.locator('[data-screen="skill-detail"]')).toHaveCount(1);
  const side = page.getByRole("region", { name: "CLI and archive", exact: true });
  const provenance = page.getByRole("region", { name: "Provenance", exact: true });
  const wideSide = (await side.boundingBox())!;
  const wideProvenance = (await provenance.boundingBox())!;
  expect(wideSide.x).toBeGreaterThanOrEqual(
    wideProvenance.x + wideProvenance.width,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const title = (await page
    .getByRole("heading", { level: 1, name: "Detail skill", exact: true })
    .boundingBox())!;
  const narrowSide = (await side.boundingBox())!;
  const narrowProvenance = (await provenance.boundingBox())!;
  expect(narrowSide.y).toBeGreaterThanOrEqual(title.y + title.height);
  expect(narrowSide.y + narrowSide.height).toBeLessThanOrEqual(
    narrowProvenance.y,
  );
});

test("narrow detail wraps long text and commands with accessible headings/controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(
    page,
    skill({
      slug: "s".repeat(300),
      source_path: "p".repeat(300),
      description: "D".repeat(300),
    }),
  );
  await open(page);
  await ready(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: "/tmp/headjack-t4-narrow-fixture.png",
    fullPage: true,
  });
});

test("forbidden history cancels a pending archive before a late success can download", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, options) => {
      if (!String(input).endsWith("/download")) return original(input, options);
      (window as any).archiveStarted = true;
      options?.signal?.addEventListener("abort", () => {
        (window as any).archiveAborted = true;
      });
      return new Promise<Response>((resolve) => {
        (window as any).releaseArchive = () => {
          resolve(new Response("archive"));
          setTimeout(() => {
            (window as any).archiveTerminal = true;
          }, 0);
        };
      });
    };
    URL.createObjectURL = () => {
      (window as any).downloadAttempt = true;
      return "blob:late";
    };
  });
  await fixtures(page);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/api/skills/*/reviews", async (route) => {
    await hold;
    await route.fulfill({
      status: 403,
      json: { error: { message: "No access" } },
    });
  });
  await open(page);
  await ready(page);
  await page.getByRole("button", { name: "Download archive" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).archiveStarted))
    .toBe(true);
  release();
  await expect(
    page.getByRole("heading", { name: "Access unavailable" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).releaseArchive());
  await expect
    .poll(() => page.evaluate(() => (window as any).archiveTerminal))
    .toBe(true);
  expect(
    await page.evaluate(() => (window as any).downloadAttempt),
  ).toBeUndefined();
  expect(await page.evaluate(() => (window as any).archiveAborted)).toBe(true);
});


test("recorded findings and quality are readable, bounded, complete and inert", async ({ page }) => {
  const flags = Array.from({ length: 50 }, (_, i) => ({
    rule: "external-url", severity: "low", file: `docs/example-${i}.md`, line: i,
    match: "https://example.com", extra_note: i === 49 ? hostile : "Recorded context",
  }));
  await fixtures(page, skill({ scan_flags: flags, quality: {
    reuse: 3, health: 0, content: 2, trigger: 1, verdict: "VAULT_AFTER_FIX",
    audited_at: "2026-09-23T12:00:00+02:00", future_assessment: { note: hostile },
  } }), [version({ scan_flags: flags })]);
  await open(page); await ready(page);
  const current = page.getByRole("region", { name: "Current review", exact: true });
  const disclosure = current.locator("details");
  await expect(disclosure.locator("summary")).toHaveText("50 scan findings");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await disclosure.locator("summary").focus(); await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(current.getByText("docs/example-49.md", { exact: true })).toBeVisible();
  await expect(disclosure.getByText(hostile, { exact: true })).toBeVisible();
  await expect(current.locator(".scan-findings > li")).toHaveCount(50);
  const first = current.locator(".scan-findings > li").first();
  for (const label of ["Rule", "Severity", "File", "Line", "Match", "extra_note"])
    await expect(first.locator("dt").filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
  await expect(first.locator("dd").filter({ hasText: /^0$/ })).toBeVisible();
  const bounds = await current.locator(".metadata-scroll").evaluate((el) => ({
    scroll: el.scrollHeight, client: el.clientHeight, overflow: getComputedStyle(el).overflowY,
  }));
  expect(bounds.scroll).toBeGreaterThan(bounds.client); expect(bounds.overflow).toBe("auto");
  const quality = page.getByRole("region", { name: "Quality and updates", exact: true });
  for (const [label, value] of [["Reuse", "3"], ["Health", "0"], ["Content", "2"], ["Trigger", "1"], ["Verdict", "VAULT_AFTER_FIX"]])
    await expect(quality.locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd")).toHaveText(value);
  await expect(quality.locator("time")).toHaveAttribute("datetime", "2026-09-23T12:00:00+02:00");
  await expect(quality.locator("time")).toContainText("September 23, 2026");
  await expect(quality.locator("time")).toContainText("UTC");
  await quality.getByText("Additional recorded fields", { exact: true }).click();
  await expect(quality.getByText("future_assessment", { exact: true })).toBeVisible();
  await expect(quality.getByText(hostile, { exact: true })).toBeVisible();
  await expect(page.locator("article script")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Version history", exact: true }).locator("summary")).toHaveText("50 scan findings");
  await expect(current.locator("time")).toHaveAttribute("datetime", "2026-10-05T12:00:00Z");
  await expect(page.getByText(hash, { exact: true }).first()).toBeVisible();
});

test("empty scans and invalid dates retain recorded truth without certification", async ({ page }) => {
  await fixtures(page, skill({ scan_flags: [], reviewed_at: "unparsed recorded timestamp", quality: { reuse: 0, audited_at: null, custom_flag: false } }));
  await open(page); await ready(page);
  await expect(page.getByText("No scan findings recorded.", { exact: true })).toBeVisible();
  await expect(page.getByText("unparsed recorded timestamp", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Current review", exact: true }).locator("time")).toHaveCount(0);
  await expect(page.getByText(/Certified|Verified|100%/)).toHaveCount(0);
});


test("prototype-named unknown scan and quality fields stay labelled and inert", async ({ page }) => {
  const keys = ["__proto__", "constructor", "toString"];
  const unknown = JSON.parse(JSON.stringify(Object.fromEntries(keys.map((key) => [key, { [key]: hostile }]))));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixtures(page, skill({ scan_flags: [{ rule: "external-url", ...unknown }], quality: { reuse: 0, ...unknown } }));
  await open(page); await ready(page);
  const current = page.getByRole("region", {name: "Current review", exact: true});
  const quality = page.getByRole("region", {name: "Quality and updates", exact: true});
  await quality.getByText("Additional recorded fields", {exact: true}).click();
  for (const region of [current, quality]) {
    for (const key of keys)
      await expect(region.locator("dt").filter({hasText: new RegExp(`^${key}$`)})).toHaveCount(2);
    await expect(region.getByText(hostile, {exact: true}).first()).toBeVisible();
  }
  await expect(page.locator("article script")).toHaveCount(0);
  expect(errors).toEqual([]);
  await fixtureScreenshot(page, "prototype-named-fields");
});
