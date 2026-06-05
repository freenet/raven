import { test, expect, type Page, type FrameLocator } from "@playwright/test";

// Liveness check against a node-SERVED production webapp — the contract URL
// (/v1/contract/web/<id>/) passed as BASE_URL by
// scripts/smoke-test-production.sh after a real `cargo make publish-*`.
//
// This lives under node-e2e/ (NOT the offline tier) because it asserts the
// node-served reality, which is the OPPOSITE of the offline `vite preview`
// build that web/tests/production-liveness.spec.ts targets:
//   • node-served: top-frame title "Freenet", app mounts inside a sandboxed
//     <iframe id="app"> (freenetBridge loader), connects to the live network →
//     no identity → onboarding.
//   • offline preview: title "Raven", app mounts directly in the top document,
//     mock posts render.
// The default playwright.config.ts ignores node-e2e/, so CI's offline
// ui-playwright-tests never runs this; the smoke runner targets it explicitly.

/** The packaged app runs inside the sandboxed loader iframe. */
function app(page: Page): FrameLocator {
  return page.frameLocator("iframe#app");
}

test.beforeEach(({ baseURL }) => {
  expect(
    baseURL,
    "BASE_URL must be the node-served contract URL — run via scripts/smoke-test-production.sh",
  ).toBeTruthy();
});

test("node serves the published webapp (loader + sandbox iframe mounts)", async ({ page }) => {
  // goto("") navigates to baseURL verbatim — the /v1/contract/web/<id>/ URL.
  // goto("/") would resolve to the ORIGIN root (dropping the contract path) and
  // hit the node's "FN Peer" status page instead of the served webapp.
  await page.goto("", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveTitle("Freenet", { timeout: 20_000 });
  const iframe = page.locator("iframe#app");
  await expect(iframe).toHaveAttribute("src", /\/v1\/contract\/web\/.+__sandbox=1/, {
    timeout: 20_000,
  });
});

test("app mounts inside the iframe and reaches a live UI", async ({ page }) => {
  await page.goto("", { waitUntil: "domcontentloaded" });
  const a = app(page);

  // A freshly published prod webapp connects to the live network and queries the
  // delegate; with no identity it lands on onboarding. A returning user with a
  // persisted identity lands on the app shell. Either is a healthy live mount.
  await expect
    .poll(
      async () =>
        (await a.locator(".onboarding-overlay").count()) > 0 ||
        (await a.locator("aside.sidebar").count()) > 0,
      { timeout: 30_000 },
    )
    .toBeTruthy();
});
