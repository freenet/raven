import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // node-e2e/ specs require a live node (run via playwright.node.config.ts +
  // scripts/node-e2e.sh); the offline tier must never pick them up.
  testIgnore: "**/node-e2e/**",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8082",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
    { name: "webkit",   use: { ...devices["Desktop Safari"] } },
  ],
});
