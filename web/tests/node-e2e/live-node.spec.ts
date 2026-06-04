import { test, expect, type Page, type FrameLocator } from "@playwright/test";

// End-to-end against a LIVE Freenet node (booted + published by
// scripts/node-e2e.sh). Unlike the offline tier these exercise the real stack:
// the node serves the packaged web container, which mounts the app inside a
// sandboxed <iframe id="app"> (the freenetBridge loader), opens a WebSocket to
// the node's /v1/contract/command, wires the identity delegate, and drives the
// onboarding -> identity -> feed flow against compiled WASM in the node.
//
// The app lives INSIDE the iframe, so UI assertions go through frameLocator.

/** The packaged app runs inside the sandboxed loader iframe. */
function app(page: Page): FrameLocator {
  return page.frameLocator("iframe#app");
}

/** Collect WS urls + console for connection assertions. */
function instrument(page: Page) {
  const ws: string[] = [];
  const logs: string[] = [];
  page.on("websocket", (s) => ws.push(s.url()));
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  return { ws, logs };
}

test.beforeEach(({ baseURL }) => {
  // baseURL is the node-served contract URL injected by the harness; fail loud
  // if a human ran this config directly without the harness.
  expect(
    baseURL,
    "BASE_URL must be the node-served webapp URL — run via `cargo make test-ui-node-e2e`",
  ).toBeTruthy();
});

test("node serves the packaged web container (loader + sandbox iframe)", async ({ page }) => {
  // goto("") navigates to baseURL verbatim. goto("/") would resolve to the
  // ORIGIN root (dropping the /v1/contract/web/<CID>/ path) and hit the node's
  // "FN Peer" status page instead of the served webapp.
  await page.goto("", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Freenet", { timeout: 20_000 });
  // The loader wraps the app in a sandboxed iframe pointing back at the contract.
  const iframe = page.locator("iframe#app");
  await expect(iframe).toHaveAttribute("src", /\/v1\/contract\/web\/.+__sandbox=1/, {
    timeout: 20_000,
  });
});

test("app connects to the live node over the websocket API + wires the delegate", async ({
  page,
}) => {
  const { ws, logs } = instrument(page);
  // goto("") navigates to baseURL verbatim. goto("/") would resolve to the
  // ORIGIN root (dropping the /v1/contract/web/<CID>/ path) and hit the node's
  // "FN Peer" status page instead of the served webapp.
  await page.goto("", { waitUntil: "domcontentloaded" });

  // The packaged app (NOT the offline mock) opens a real WS to the node.
  await expect
    .poll(() => ws.some((u) => u.includes("/v1/contract/command")), { timeout: 30_000 })
    .toBeTruthy();

  // And reports a live connection + a wired identity delegate in-page.
  await expect
    .poll(() => logs.some((l) => l.includes("Connected to Freenet node")), { timeout: 30_000 })
    .toBeTruthy();
  await expect
    .poll(() => logs.some((l) => l.includes("[identity] Delegate connection wired")), {
      timeout: 30_000,
    })
    .toBeTruthy();
});

test("fresh delegate replies 'no identity' over the live API -> onboarding renders", async ({
  page,
}) => {
  const { logs } = instrument(page);
  // goto("") navigates to baseURL verbatim. goto("/") would resolve to the
  // ORIGIN root (dropping the /v1/contract/web/<CID>/ path) and hit the node's
  // "FN Peer" status page instead of the served webapp.
  await page.goto("", { waitUntil: "domcontentloaded" });

  // The decisive assertion that this is a LIVE node (not offline mock, not a
  // cached DOM): the app received a real delegate response and decided to show
  // onboarding because of it. Offline mode logs "[offline] Booting…" and never
  // queries a delegate, so this signal cannot appear without a live node.
  await expect
    .poll(() => logs.some((l) => l.includes("[identity] No identity in delegate — show onboarding")), {
      timeout: 30_000,
    })
    .toBeTruthy();

  // …and the onboarding UI is what the user actually sees inside the iframe.
  await expect(app(page).locator(".onboarding-overlay")).toBeVisible({ timeout: 10_000 });
  await expect(app(page).locator(".onboarding-title")).toContainText("Welcome to Raven", {
    timeout: 10_000,
  });
});

test("creating an identity advances past onboarding to the app shell", async ({ page }) => {
  const { logs } = instrument(page);
  // goto("") navigates to baseURL verbatim. goto("/") would resolve to the
  // ORIGIN root (dropping the /v1/contract/web/<CID>/ path) and hit the node's
  // "FN Peer" status page instead of the served webapp.
  await page.goto("", { waitUntil: "domcontentloaded" });
  const a = app(page);

  // Wait for the live "show onboarding" decision before interacting, so we know
  // the app is past delegate-wiring and not mid-boot.
  await expect
    .poll(() => logs.some((l) => l.includes("[identity] No identity in delegate — show onboarding")), {
      timeout: 30_000,
    })
    .toBeTruthy();
  await expect(a.locator(".onboarding-overlay")).toBeVisible({ timeout: 10_000 });

  // Type a display name and Join. NOTE: the app renders the shell client-side on
  // Join (createIdentity -> renderApp) and fires the delegate CreateIdentity
  // write asynchronously; this asserts the onboarding->app UI transition against
  // the node-served build. (Verifying the delegate actually PERSISTED the
  // identity across a reload is the deeper #34 tier.)
  await a.locator(".onboarding-input").first().fill("E2E Tester");
  const join = a.locator(".onboarding-btn", { hasText: "Join" });
  await expect(join).toBeEnabled({ timeout: 10_000 });
  await join.click();

  await expect(a.locator(".onboarding-overlay")).toBeHidden({ timeout: 45_000 });
  await expect(a.locator("aside.sidebar")).toBeVisible({ timeout: 45_000 });
});
