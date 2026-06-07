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
  // page.on("console") only surfaces the TOP frame. The app runs inside the
  // sandboxed iframe, so its logs (identity / publish / global-index share)
  // arrive on the FRAME's console — capture both or the share path is invisible.
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

test("logged-out visitor: public timeline loads behind onboarding (live GET)", async ({
  page,
}) => {
  // MUST run before "creating an identity" — once the shared delegate persists
  // an identity, onboarding (and thus the landing feed) never shows again.
  const { logs } = instrument(page);
  await page.goto("", { waitUntil: "domcontentloaded" });
  const a = app(page);

  // Onboarding up (fresh delegate -> no identity) == logged-out.
  await expect
    .poll(() => logs.some((l) => l.includes("[identity] No identity in delegate — show onboarding")), {
      timeout: 30_000,
    })
    .toBeTruthy();

  // The read-only landing feed mounts UNDER the onboarding overlay so the page
  // is never blank for a logged-out visitor. (Both live inside the app iframe.)
  await expect(a.locator(".landing-feed")).toBeAttached({ timeout: 15_000 });
  await expect(a.locator(".onboarding-overlay")).toBeVisible({ timeout: 10_000 });

  // Live-only signal: loadGlobalIndex() derived the singleton key and issued a
  // GET. This fires regardless of whether the index is instantiated — a FRESH
  // node has no index, so the GET rejects and the "Loaded N …" success log never
  // appears; asserting it would make the spec depend on a pre-populated index.
  // The "loading public timeline" marker proves the read path is wired
  // end-to-end (key derivation -> serialized GET) and cannot appear offline
  // (offline mode never connects, never derives the key, never GETs).
  await expect
    .poll(() => logs.some((l) => l.includes("[global-index] loading public timeline")), {
      timeout: 30_000,
    })
    .toBeTruthy();
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

// --- Global-index public timeline (read/render side of #49) ----------------
// These exercise the live read path: loadGlobalIndex() GETs the singleton over
// the real node WS, the result feeds the pre-auth landing feed (logged-out) and
// the Home -> Discover tab (logged-in). The decisive live-only signal is the
// "[freenet] Loaded N public-timeline posts" console line — it only logs after a
// real GET response from the node (offline mock never connects, never GETs).
//
// IMPORTANT — shared-node state: the config is serial (workers:1) against ONE
// node + delegate, and the "creating an identity" spec persists an identity
// that survives into later specs (the delegate then replies Identity, not "no
// identity", so onboarding NEVER shows again). So:
//  * the LOGGED-OUT landing-feed spec is placed BEFORE "creating an identity",
//    the only point at which onboarding is guaranteed.
//  * specs needing the LOGGED-IN app are order-independent via ensureAppShell():
//    register IF onboarding is showing, otherwise the shell is already up from a
//    prior spec's identity — proceed either way.

/**
 * Drive the app to the logged-in shell, tolerant of shared-node state. If the
 * delegate has no identity yet, onboarding shows and we register; if a prior
 * spec already created one, the shell is already up and we just wait for it.
 * Returns the app FrameLocator with the sidebar visible.
 */
async function ensureAppShell(page: Page, displayName: string): Promise<FrameLocator> {
  const a = app(page);
  const onboarding = a.locator(".onboarding-overlay");
  const sidebar = a.locator("aside.sidebar");
  // Race: whichever the live delegate decided. Wait until ONE is present.
  await expect
    .poll(async () => (await onboarding.count()) > 0 || (await sidebar.count()) > 0, {
      timeout: 30_000,
    })
    .toBeTruthy();
  if ((await onboarding.count()) > 0 && (await sidebar.count()) === 0) {
    await a.locator(".onboarding-input").first().fill(displayName);
    const join = a.locator(".onboarding-btn", { hasText: "Join" });
    await expect(join).toBeEnabled({ timeout: 10_000 });
    await join.click();
  }
  await expect(sidebar).toBeVisible({ timeout: 45_000 });
  return a;
}

test("logged-in: Home -> Discover tab renders the global index (not the old stub)", async ({
  page,
}) => {
  await page.goto("", { waitUntil: "domcontentloaded" });
  const a = await ensureAppShell(page, "Discover Tester");

  // Switch to the Discover tab — previously a dead "Discover is quiet right now"
  // stub; now it renders the global-index read path.
  const discoverTab = a.locator(".feed-tab", { hasText: "Discover" });
  await expect(discoverTab).toBeVisible({ timeout: 10_000 });
  await discoverTab.click();

  // The old stub copy must be GONE (proves the stub branch was replaced).
  await expect(a.locator(".feed__posts")).not.toContainText("Discover is quiet right now", {
    timeout: 10_000,
  });
  // With a fresh/near-empty index the read path renders either the new empty
  // note or real post cards — both prove the wired render, never the old stub.
  await expect
    .poll(
      async () => {
        const empty = await a.locator(".feed__posts .following-note__title").count();
        const cards = await a.locator(".feed__posts .post").count();
        return empty > 0 || cards > 0;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
});

// Full write->index->render round-trip: compose with "share to public timeline"
// ON, then see the post in the Discover tab (same session). This was long
// skipped as a presumed #50 propagation seam, but the real blocker was a client
// bug: every shard PUT (user/thread/global-index) built its PutRequest with
// `relatedContracts = undefined`, and that flatbuffer field is REQUIRED — so the
// Put failed to serialize ("field 8 must be set") and NO shard was ever
// instantiated from the browser. With that fixed (RelatedContractsT([]) + the
// packable `…T` container tables), the singleton instantiates on first share and
// the sharer's own subscription delivers the post back into Discover.
test("round-trip: a shared post reaches the Discover timeline", async ({ page }) => {
  // register (or reuse the shared identity) -> compose with the public-timeline
  // toggle ON -> reload -> the post should surface in the Discover tab.
  await page.goto("", { waitUntil: "domcontentloaded" });
  const a = await ensureAppShell(page, "RoundTrip Tester");

  // Compose a post with a UNIQUE marker (re-runs share the node, so a fixed
  // string could already be present from a prior run; the timestamp keeps it
  // distinct enough for this run's assertion) and tick "Share to public timeline".
  const marker = `e2e-roundtrip-${Date.now()}`;
  await a.locator(".quickpost").click();
  await expect(a.locator(".compose-modal-overlay")).toBeVisible({ timeout: 10_000 });
  await a.locator(".compose-modal__textarea").fill(marker);
  await a.locator(".compose-modal__share-check").check();
  const postBtn = a.locator(".compose-modal__post");
  await expect(postBtn).toBeEnabled({ timeout: 10_000 });
  await postBtn.click();
  await expect(a.locator(".compose-modal-overlay")).toBeHidden({ timeout: 15_000 });

  // SAME-SESSION read (what a real user sees — they don't reload after posting):
  // the sharer already subscribed to the global index at boot, so its own shared
  // post arrives back as a live UPDATE delta and renders in Discover. This proves
  // the full write→instantiate→index→render path on a live node without relying
  // on a fresh-boot GET of the just-instantiated singleton (the cross-session
  // reload-GET tail is the still-open single-node #50 seam).
  const discoverTab = a.locator(".feed-tab", { hasText: "Discover" });
  await expect(discoverTab).toBeVisible({ timeout: 30_000 });
  await discoverTab.click();
  await expect
    .poll(async () => a.locator(".feed__posts").getByText(marker).count(), {
      timeout: 90_000,
      message: "shared post did not surface in the Discover timeline (same session)",
    })
    .toBeGreaterThan(0);
});
