import { test, expect, type Page, type FrameLocator } from "@playwright/test";

// Liveness check against a node-SERVED production webapp (the contract URL
// passed as baseURL by scripts/smoke-test-production.sh). The node serves the
// packaged web container, which mounts the app inside a sandboxed
// <iframe id="app"> (the freenetBridge loader). The top frame title is
// "Freenet" and the actual Raven UI lives INSIDE the iframe — so UI assertions
// must go through the frame locator, NOT the top document.

/** The packaged app runs inside the sandboxed loader iframe. */
function app(page: Page): FrameLocator {
  return page.frameLocator("iframe#app");
}

test("node serves the published webapp (loader + sandbox iframe mounts)", async ({ page }) => {
  // goto("") navigates to baseURL verbatim — the /v1/contract/web/<id>/ URL.
  // goto("/") would resolve to the ORIGIN root (dropping the contract path) and
  // hit the node's "FN Peer" status page instead of the served webapp.
  await page.goto("", { waitUntil: "domcontentloaded" });

  // The node-served loader sets the top-frame title to "Freenet" and wraps the
  // app in a sandboxed iframe pointing back at the contract.
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
  // persisted identity lands on the app shell. Either is a healthy live mount —
  // assert the app reached one of them inside the iframe.
  await expect
    .poll(
      async () =>
        (await a.locator(".onboarding-overlay").count()) > 0 ||
        (await a.locator("aside.sidebar").count()) > 0,
      { timeout: 30_000 },
    )
    .toBeTruthy();
});
