import { defineConfig, devices } from "@playwright/test";

// Node-backed E2E config: specs under node-e2e/ run against the webapp SERVED BY
// a live Freenet node (BASE_URL points at http://127.0.0.1:<port>/v1/contract/
// web/<CID>/). Driven by scripts/node-e2e.sh, which boots the node + publishes.
// Kept separate from playwright.config.ts (the offline tier) so the offline job
// never tries to run these and vice-versa.
//
// Timeouts are larger than the offline config: a real node round-trip (WS
// connect, delegate query, contract PUT/GET) is slower than rendering mock data.
export default defineConfig({
  testDir: "./node-e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  // Real node state is shared across specs in one published instance; keep it
  // serial so an identity created by one spec can't race another's assertions.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-node", open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
