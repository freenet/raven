export const meta = {
  name: 'svelte-port',
  description: 'Port freenet-raven web UI (vanilla TS components) to Svelte, keeping rust/WASM + WS api layer intact',
  phases: [
    { title: 'Plan', detail: 'map each component → Svelte spec, preserving class names + store deps', model: 'opus' },
    { title: 'Scaffold', detail: 'svelte+vite deps, store layer wrapping freenet-api, App.svelte shell', model: 'opus' },
    { title: 'Components', detail: 'one low-effort opus agent per component → .svelte, preserve classes', model: 'opus' },
    { title: 'Wire+Verify', detail: 'entry point, tsc/vitest/build, fix breakage', model: 'opus' },
  ],
}

// ---------------------------------------------------------------------------
// Fixed context handed to every agent. The port's hard contracts.
// ---------------------------------------------------------------------------
const WEB = 'web'
const CTX = `
PROJECT: freenet-raven — decentralized microblogging on Freenet. Web UI in ${WEB}/src.
TASK: Port the vanilla-TS imperative-DOM UI to Svelte 5 (runes). Effort: LOW — do the
mechanical port faithfully, do NOT redesign, do NOT add features, do NOT touch styling logic.

HARD CONTRACTS (violating any = broken build / broken E2E):
1. DO NOT MODIFY these framework-agnostic files — import them as-is from Svelte stores/components:
   freenet-api.ts (1405 LOC WS+contract hub), delegate-api.ts, identity.ts, shard-key.ts,
   types.ts, utils.ts, mock-data.ts, theme.ts, branding.ts, and the *.test.ts files.
   The rust→WASM contracts, delegate, and WebSocket layer are OUT OF SCOPE. Never edit Rust.
2. PRESERVE CSS CLASS NAMES EXACTLY. Playwright E2E selects by class, not data-testid.
   Known selectors that MUST keep working (emit identical markup classes):
   iframe#app, aside.sidebar, .sidebar-post-btn, article.post / .post, .feed__posts,
   .feed-tab (text "Discover"), .following-note__title, .quickpost,
   .onboarding-overlay/.onboarding-title/.onboarding-input/.onboarding-btn (text "Join"),
   .compose-modal-overlay/.compose-modal/.compose-modal__textarea/.compose-modal__post/
   .compose-modal__share-check, .landing-feed.
   Element TYPE matters too: aside.sidebar, article.post, main.feed-column.
3. KEEP SCSS as-is. Import src/scss/styles.scss globally (in App.svelte or entry). Do not
   convert SCSS to Svelte scoped styles — components reuse the existing global classes.
4. PRESERVE the optimistic-then-reconcile + global-index MERGE-not-replace semantics that
   currently live in index.ts. These move into Svelte stores, logic UNCHANGED. The store
   wraps FreenetConnection's callback interface (onPostsLoaded/onNewPost/onGlobalPostsLoaded/
   onNewGlobalPost/onLikeUpdated/onRepostUpdated/onQuoteUpdated/onStatusChange/
   onDelegateResponse) and exposes reactive writable stores instead of imperative updatePosts().
5. Offline mode (__OFFLINE_MODE__) must still boot with MOCK_POSTS for CI/Playwright.

WORKING DIR: this run is in a git worktree. Edit files under ${WEB}/ directly.
`

phase('Plan')

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    storeLayer: {
      type: 'string',
      description: 'Spec for the Svelte store module(s) that wrap freenet-api: which writable/derived stores, how each FreenetConnection callback maps to a store write, where optimistic-reconcile + global merge logic lands.',
    },
    appShell: {
      type: 'string',
      description: 'Spec for App.svelte: view routing (feed/explore/notifications/profile/settings/thread), how it replaces app.ts createApp orchestration.',
    },
    entry: {
      type: 'string',
      description: 'Spec for the new entry (main.ts mounting App.svelte): how index.ts boot logic — splash, onboarding, delegate wiring, offline mode — is preserved.',
    },
    components: {
      type: 'array',
      description: 'One entry per component to port.',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'source file e.g. src/components/feed.ts' },
          target: { type: 'string', description: 'target e.g. src/components/Feed.svelte' },
          props: { type: 'string', description: 'Svelte props (was the create* fn args / callbacks interface)' },
          classNames: { type: 'string', description: 'exact CSS classes + element types this component MUST emit (for E2E + SCSS)' },
          storeDeps: { type: 'string', description: 'which stores it reads/writes' },
          notes: { type: 'string', description: 'imperative handles (e.g. updatePosts) it currently exposes that become reactive; gotchas' },
        },
        required: ['source', 'target', 'props', 'classNames', 'storeDeps'],
      },
    },
  },
  required: ['storeLayer', 'appShell', 'entry', 'components'],
}

const plan = await agent(
  `${CTX}

Read the entire ${WEB}/src tree (all components, app.ts, index.ts, freenet-api.ts public interface,
identity.ts, types.ts) and produce a complete, file-by-file Svelte port spec. Read every component's
exported create* signature and the exact DOM classes/element types it builds. For each component
list the precise class names and element types it must reproduce. Pay special attention to index.ts:
catalog every FreenetConnection callback and the state it mutates — that becomes the store layer.
Be exhaustive and concrete; downstream agents implement directly from your spec without re-reading
index.ts.`,
  { label: 'plan:port-spec', phase: 'Plan', schema: PLAN_SCHEMA, model: 'opus' }
)

log(`Plan: ${plan.components.length} components + store layer + shell + entry`)

// ---------------------------------------------------------------------------
// Scaffold — sequential foundation everything else imports. Must land first.
// ---------------------------------------------------------------------------
phase('Scaffold')

const scaffold = await agent(
  `${CTX}

SCAFFOLD PHASE. Implement the foundation that components depend on. Do these, in ${WEB}/:
1. Add Svelte to the toolchain: add "svelte" + "@sveltejs/vite-plugin-svelte" + "svelte-check"
   to package.json devDependencies (pick versions compatible with the installed vite ^6.3.0 —
   svelte 5.x and @sveltejs/vite-plugin-svelte ^5.x). Add svelte() plugin to vite.config.ts
   WITHOUT removing the existing define{} block, css scss block, base, build, server, or test
   config — those stay. Add a svelte.config.js if the plugin needs one (vitePreprocess).
   Add a "check" script running svelte-check.
2. Build the STORE LAYER per this spec:
${JSON.stringify(plan.storeLayer, null, 2)}
   Create src/stores/ modules. The store module constructs the FreenetConnection (or accepts one)
   and translates its callbacks into Svelte writable stores: posts, globalPosts, status, identity.
   MOVE the optimistic-reconcile + global-index merge-not-replace logic from index.ts into the
   store callbacks VERBATIM (same dedup sets, same sort, same survivor-merge). Export typed stores.
   Do NOT modify freenet-api.ts — import FreenetConnection and its callback types from it.
3. Create src/App.svelte shell per this spec:
${JSON.stringify(plan.appShell, null, 2)}
   It imports src/scss/styles.scss globally. It holds the view-routing state and renders the
   sidebar + main area + right panel, switching views. Reference child components by their planned
   target paths (they'll be created in the next phase) — stub-import is fine, they will exist.

Return a concise report of exact files created/edited and the store store-names + their types,
so component agents know the import paths and store names.`,
  { label: 'scaffold:foundation', phase: 'Scaffold', model: 'opus' }
)

log('Scaffold done')

// ---------------------------------------------------------------------------
// Components — fan out, one low-effort agent per component. Worktree already
// isolates the whole run, and these write DISJOINT files (one .svelte each),
// so no per-agent worktree needed.
// ---------------------------------------------------------------------------
phase('Components')

const compResults = await parallel(
  plan.components.map((c) => () =>
    agent(
      `${CTX}

COMPONENT PORT — LOW EFFORT, mechanical. Port ONE component to Svelte 5 (runes: $props, $state,
$derived, $effect). Do not redesign.

Source: ${c.source}
Target: ${c.target}
Props: ${c.props}
MUST emit these exact classes + element types: ${c.classNames}
Store deps: ${c.storeDeps}
Notes: ${c.notes || '(none)'}

Scaffold report (store names / import paths to use):
${scaffold}

Rules:
- Read ${c.source} first. Reproduce its DOM structure, classes, element types, and event wiring
  faithfully in Svelte markup. Same text content, same attributes, same conditionals.
- Imperative handles it exposed (e.g. updatePosts(), updateGlobalPosts()) become reactive: the
  component reads the relevant store and re-renders automatically. Remove the imperative setter.
- Callbacks (onLike/onCompose/...) become Svelte props (callback props or events). Keep names.
- Import shared helpers (utils.ts, types.ts, identity.ts, post-card) — do NOT reimplement them.
  Do NOT edit any non-Svelte source file.
- Write ${c.target}. Do not touch other components.

Return one line: target path + the classes you emitted.`,
      { label: `port:${c.target.split('/').pop()}`, phase: 'Components', model: 'opus' }
    )
  )
)
const ported = compResults.filter(Boolean)
log(`Ported ${ported.length}/${plan.components.length} components`)

// ---------------------------------------------------------------------------
// Wire + Verify — entry point, then typecheck/test/build, then fix loop.
// ---------------------------------------------------------------------------
phase('Wire+Verify')

await agent(
  `${CTX}

WIRE PHASE. Create the new entry point that mounts the Svelte app, replacing index.ts's role.
Entry spec:
${JSON.stringify(plan.entry, null, 2)}

Scaffold report:
${scaffold}

Do:
1. Create src/main.ts that mounts App.svelte into #app (Svelte 5 mount()). Preserve ALL boot
   logic from the original index.ts: initTheme() before render, document.title, the root.dataset
   editorial tokens, showSplash behavior, onboarding flow, delegate wiring/timeout, and the
   __OFFLINE_MODE__ branch that boots with MOCK_POSTS. Logic moves into the store layer / App.svelte
   lifecycle — preserve behavior, do not drop any branch.
2. Update web/index.html if it references /src/index.ts — point it at /src/main.ts.
3. Keep the OLD index.ts/app.ts files in place for now (do not delete) so nothing else breaks;
   just stop referencing them from the entry.

Return the entry file path + any html change.`,
  { label: 'wire:entry', phase: 'Wire+Verify', model: 'opus' }
)

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    tscPass: { type: 'boolean' },
    svelteCheckPass: { type: 'boolean' },
    vitestPass: { type: 'boolean' },
    buildPass: { type: 'boolean' },
    remainingErrors: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['tscPass', 'vitestPass', 'buildPass', 'summary'],
}

const verify = await agent(
  `${CTX}

VERIFY + FIX PHASE. The Svelte port is implemented. Make the web build green WITHOUT weakening
any contract (do not delete tests, do not stub out the WS layer, do not strip class names).

Run, from ${WEB}/:
- npm install   (to pull the newly-added svelte deps; if offline registry fails, report it and continue)
- npx svelte-check   (or the "check" script) — fix Svelte/type errors in the .svelte + store files
- npm run test   (vitest — the freenet-api / shard-key unit tests MUST still pass unchanged)
- npm run build:offline   (tsc + vite build in offline mode — this is the CI gate)

Fix errors you introduced in the ported Svelte/store/entry files ONLY. If a fix would require
editing freenet-api.ts or another protected file, DO NOT — record it in remainingErrors instead.
Iterate until build:offline passes or you hit an unfixable protected-file conflict.

Report pass/fail per gate honestly. Do not claim a gate passed without running it.`,
  { label: 'verify:gates', phase: 'Wire+Verify', schema: VERIFY_SCHEMA, model: 'opus' }
)

return {
  componentsPlanned: plan.components.length,
  componentsPorted: ported.length,
  verify,
}
