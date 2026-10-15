import { mkdir } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
export const row = (name = "Alpha skill", extra = {}) => ({
  slug: name.toLowerCase().replaceAll(" ", "-"),
  name,
  description: "Useful <script>remote text</script>",
  kind: "skill",
  plugin_slug: null,
  tags: ["react"],
  quality: { verdict: "keep", reuse: 3 },
  update_available: true,
  has_approved_version: true,
  ...extra,
});
export async function session(
  page: Page,
  userId: string | null = "owner_a",
  sessionId = "session_a",
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
// True when the page has no horizontal scroll at the current viewport.
export function fitsViewport(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
}
// Answers every browse read with the given rows.
export async function browseRows(page: Page, skills: unknown[], total = skills.length) {
  await page.route("**/api/skills?*", (route) =>
    route.fulfill({ json: { skills, total, limit: 24, offset: 0 } }),
  );
}
export async function openLibrary(page: Page, url = "/library") {
  await page.goto(url);
  await session(page);
}
// Deliberately ignore fetch cancellation so the production generation guard must
// reject late results. Terminal is set after JSON consumption and its handlers.
export async function deferredReads(page: Page, prefix: string) {
  await page.addInitScript((prefix) => {
    const original = window.fetch;
    const reads: {resolve: (response: Response) => void; aborted: boolean}[] = [];
    const control = (window as any).deferredRead = {
      enabled: true, started: 0, terminal: 0, expired: 0,
      release(status: number, body: unknown) {
        for (const read of reads.splice(0)) {
          const response = Response.json(body, {status});
          const json = response.json.bind(response);
          response.json = async () => {
            try { return await json(); }
            finally { setTimeout(() => ++control.terminal, 0); }
          };
          read.resolve(response);
        }
      },
      get aborted() { return reads.filter((read) => read.aborted).length; },
    };
    window.addEventListener("headjack-private-session-expired", () => ++control.expired);
    window.fetch = (input, options) => {
      if (!control.enabled || !String(input).startsWith(prefix)) return original(input, options);
      ++control.started;
      return new Promise<Response>((resolve) => {
        const read = {resolve, aborted: Boolean(options?.signal?.aborted)};
        reads.push(read);
        options?.signal?.addEventListener("abort", () => {read.aborted = true;});
      });
    };
  }, prefix);
}
export async function releaseReads(page: Page, status: number, body: unknown) {
  const started = await page.evaluate(() => (window as any).deferredRead.started);
  await page.evaluate(({status, body}) => (window as any).deferredRead.release(status, body), {status, body});
  await expect.poll(() => page.evaluate(() => (window as any).deferredRead.terminal)).toBe(started);
  // Give React a render opportunity after the late response handlers finish.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

export async function fixtureScreenshot(page: Page, name: string) {
  const directory = "/tmp/headjack-premium-fixture-evidence";
  await mkdir(directory, {recursive: true});
  await page.screenshot({path: `${directory}/fixture-only-${name}.png`, fullPage: true});
}
