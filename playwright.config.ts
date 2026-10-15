import { defineConfig, devices } from "@playwright/test";

// Fixture QA only. These ports/timeouts and the encryption key are local test configuration.
export const browserConfig = {
  fixturePort: 3217,
  smokePort: 3218,
  timeout: 30_000,
  startupTimeout: 120_000,
  flagsSecret: Buffer.alloc(32, 7).toString("base64"),
};
export default defineConfig({
  testDir: "./test/browser",
  timeout: browserConfig.timeout,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "/tmp/headjack-playwright-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${browserConfig.fixturePort}`,
  },
  projects: [
    {
      name: "fixture-qa-never-deploy",
      testMatch: /(?:shell|library|private-state|detail|updates-guide)\.spec\.ts/,
    },
    {
      name: "unmocked-configuration-smoke",
      testMatch: /missing-clerk\.spec\.ts/,
      use: { baseURL: `http://localhost:${browserConfig.smokePort}` },
    },
  ],
  webServer: [
    {
      command: `node scripts/ui-fixture-server.mjs fixture ${browserConfig.fixturePort}`,
      url: `http://localhost:${browserConfig.fixturePort}/qa-ready.css`,
      timeout: browserConfig.startupTimeout,
      reuseExistingServer: false,
    },
    {
      command: `node scripts/ui-fixture-server.mjs unmocked ${browserConfig.smokePort}`,
      url: `http://localhost:${browserConfig.smokePort}/qa-ready.css`,
      timeout: browserConfig.startupTimeout,
      reuseExistingServer: false,
      env: { FLAGS_SECRET: browserConfig.flagsSecret },
    },
  ],
});
