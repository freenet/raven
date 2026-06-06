export const meta = {
  name: 'global-index-read-render',
  description: 'Implement the UI read/render side of the global-index public timeline (#49 follow-up)',
  phases: [
    { title: 'Scout', detail: 'gather exact shared facts (line numbers, shapes) once' },
    { title: 'API layer', detail: 'freenet-api.ts read methods + routing + callback (foundation)' },
    { title: 'Wiring + UI', detail: 'index.ts plumbing + feed/app Discover tab + pre-auth landing' },
    { title: 'Tests', detail: 'vitest coverage for the read path' },
    { title: 'Gate', detail: 'run full pre-push gate, fix failures' },
    { title: 'Review', detail: 'adversarial panel: correctness / races / plan-alignment' },
  ],
}

const MODEL = 'opus'
const ROOT = '/Volumes/PRO-G40/projects/freenet-raven'

// ---------------------------------------------------------------------------
// Phase 1 — Scout. One read-only agent pins the exact facts every later phase
// needs, so implementers don't each re-derive line numbers / JSON shapes and
// drift. Returns a structured fact sheet.
// ---------------------------------------------------------------------------
phase('Scout')
const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['notes'],
  properties: {
    notes: { type: 'string', description: 'Concise fact sheet: exact symbols, line ranges, JSON shapes, callback patterns to mirror.' },
  },
}
const facts = await agent(
  `Read-only scouting for a code change in ${ROOT}. Do NOT edit anything.

We are adding the READ/RENDER side of the global-index public-timeline contract
(the write side already shipped in PR #49). Gather the EXACT facts an implementer
needs so they don't have to re-derive them. Read these files and report:

- web/src/freenet-api.ts:
  * The WRITE-side global-index code already present: globalIndexKeyOrNull (~685),
    ensureGlobalIndex (~724), shareToGlobalIndex (~772), the globalIndex* fields
    (~261-265). Quote the field declarations verbatim.
  * handleGetResponse (~394) — the routing pattern: how it matches respId against
    userShardInstanceId and threadInstanceToRoot, and the user-shard parse path
    (rawPosts.map(contractPostToUiPost), sort desc, onPostsLoaded). Quote it.
  * handleUpdateNotification (~426) — the user-shard delta parse for {"Posts":[...]}.
  * subscribeUserShard (~599) and subscribeThread (~978) — the SubscribeRequest pattern.
  * loadState (~376) — GET pattern via serializedGet.
  * The FreenetCallbacks interface (~189) and ContractPost interface (~32),
    UserShardState (~64), contractPostToUiPost (~152). Quote ContractPost fields.
  * serializedGet signature/usage.
  * imports at top: GetRequest, SubscribeRequest, etc — confirm what's already imported.
- contracts/global-index-shard/src/lib.rs: the on-wire STATE json shape (the posts
  map — confirm it's {"posts": { "<id>": <Post> }} i.e. a MAP keyed by id, NOT a Vec)
  and the DELTA shape ({"Posts":[<Post>]}). Confirm the Post json field names match
  ContractPost (id, author_pubkey, author_name, author_handle, content, timestamp,
  quoted_post, signature) — note any extra fields like reply_to.
- web/src/index.ts: the FreenetConnection callbacks object (~150), how onPostsLoaded
  feeds localPosts + refreshFeed (~151), renderApp (~69), showOnboarding (~428), and
  the start block (~443). How would a SEPARATE global-posts buffer be threaded to the app?
- web/src/app.ts: createApp, the feed creation (~47), updatePosts (~158), navigate (~88).
  How does the app expose updatePosts to index.ts?
- web/src/components/feed.ts: the Discover tab (Tab = 'following'|'discover', renderPosts
  ~103, the discover stub branch ~105, setActiveTab, updatePosts ~168). How to add a
  second post list for discover.
- web/src/components/onboarding.ts: structure of the overlay (it's a full-screen overlay
  appended to document.body). Can a public-timeline feed render BEHIND it?
- web/src/freenet-api.test.ts: the vitest harness style — how the mock WS / api is set up,
  how a GET response is simulated, naming conventions. Quote one representative test.

Report a tight fact sheet (symbols + line numbers + verbatim shapes). Flag any
mismatch between the contract Post json and the TS ContractPost interface.`,
  { label: 'scout:facts', phase: 'Scout', model: MODEL, schema: FACTS_SCHEMA, agentType: 'Explore' },
)

const F = facts?.notes ?? '(scout returned no notes — implementer must re-read the files)'

// ---------------------------------------------------------------------------
// Phase 2 — API layer (foundation). Single agent, single primary file
// (freenet-api.ts). Everything downstream depends on the callback name + the
// load/subscribe method names this phase fixes, so it must finish first.
// ---------------------------------------------------------------------------
phase('API layer')
const apiResult = await agent(
  `Implement the global-index READ layer in ${ROOT}/web/src/freenet-api.ts. Edit ONLY
freenet-api.ts in this phase. Match the existing code style exactly (it is dense and
heavily commented — mirror the comment density and the user-shard/thread-shard patterns).

SCOUT FACT SHEET (authoritative — use these symbols/shapes, re-read the file to confirm before editing):
${F}

Implement, mirroring the WRITE side already in this file and the user-shard READ side:

1. New interface near UserShardState (~64):
   interface GlobalIndexState { posts?: Record<string, ContractPost>; }
   (a MAP keyed by id — matches the contract BTreeMap, NOT a Vec like UserShardState.)

2. New field next to globalIndexKey (~261): a globalIndexInstanceId (base58 instance id,
   string | null) mirroring userShardInstanceId. Set it inside globalIndexKeyOrNull when
   the key is first derived (this.globalIndexInstanceId = key.encode()).

3. Extend the FreenetCallbacks interface (~189) with:
   onGlobalPostsLoaded?: (posts: Post[]) => void;   // full network timeline snapshot
   onNewGlobalPost?: (post: Post) => void;           // live single post from a delta
   Make them OPTIONAL so existing callers/tests don't break.

4. loadGlobalIndex(): void  — mirror loadState (~376). Derive key via globalIndexKeyOrNull();
   if null (offline/dev) return silently. serializedGet(new GetRequest(key, true)) with a
   .catch logging "[global-index] get failed". Do NOT ensure/PUT here — a reader must never
   instantiate the singleton; absent index = empty timeline.

5. subscribeGlobalIndex(): void — mirror subscribeUserShard (~599). Guard on api + key;
   SubscribeRequest(key, []); .catch log "[global-index] subscribe failed".

6. In handleGetResponse (~394): add a routing branch BEFORE the user-shard branch's
   "drop anything else" return. If respId === this.globalIndexInstanceId: decode state json,
   parse as GlobalIndexState, take Object.values(state.posts ?? {}), map contractPostToUiPost,
   sort by timestamp desc (same comparator as the user-shard path), call
   this.callbacks.onGlobalPostsLoaded?.(posts). Return. Keep the existing thread + user-shard
   branches intact — the global-index branch must not shadow them (check threadInstanceToRoot
   and userShardInstanceId first OR check globalIndexInstanceId explicitly; make routing
   mutually exclusive and correct).

7. In handleUpdateNotification (~426): add a branch for notifId === this.globalIndexInstanceId.
   Parse the DeltaUpdate exactly like the user-shard delta path, but the global-index delta is
   {"Posts":[ContractPost,...]} (externally-tagged GlobalIndexDelta::Posts). For each post call
   this.callbacks.onNewGlobalPost?.(contractPostToUiPost(cp)). Strip the \\x00 padding like the
   user-shard path does.

Constraints:
- Do NOT touch the write-side methods (shareToGlobalIndex/ensureGlobalIndex/globalIndexKeyOrNull)
  except the one-line globalIndexInstanceId assignment inside globalIndexKeyOrNull.
- Use only imports already present (GetRequest, SubscribeRequest are used by user-shard code —
  confirm). If a needed import is missing, add it to the existing import block.
- TypeScript must compile (tsc strict). Keep names EXACT: loadGlobalIndex, subscribeGlobalIndex,
  onGlobalPostsLoaded, onNewGlobalPost, globalIndexInstanceId — downstream phases depend on them.

Report: the exact new method/field/callback names and signatures you added, and any deviation
from the above (with reason). Quote the final handleGetResponse routing branch you wrote.`,
  { label: 'impl:api', phase: 'API layer', model: MODEL },
)

// ---------------------------------------------------------------------------
// Phase 3 — Wiring + UI. Two agents on DISJOINT files (index.ts owns wiring +
// pre-auth; feed/app owns the Discover render). They share no file, so they run
// in parallel safely. Both depend on the Phase-2 callback/method names.
// ---------------------------------------------------------------------------
phase('Wiring + UI')
const wiringSummary = `PHASE-2 API LAYER RESULT (the read methods/callbacks now exist):
${apiResult}

Use these EXACT names from the API layer: connection.loadGlobalIndex(),
connection.subscribeGlobalIndex(), callbacks onGlobalPostsLoaded(posts: Post[]) and
onNewGlobalPost(post: Post).`

const [wiringRes, uiRes] = await parallel([
  () => agent(
    `Edit ONLY ${ROOT}/web/src/index.ts. Do NOT touch any other file.

${wiringSummary}

SCOUT FACTS:
${F}

Wire the global-index (public-timeline) read path into the app, following the
"how other social apps work" pattern the user chose:
- Logged-out (onboarding visible): the public timeline is the LANDING feed behind/around
  onboarding so a fresh user immediately sees live network posts.
- Logged-in: the same global-index posts feed the Home feed's Discover tab.

Implement:
1. A module-level buffer: let globalPosts: Post[] = []; and a Set<string> globalPostIds
   for dedup (mirror localPosts / knownPostIds at ~45).
2. Add to the FreenetConnection callbacks object (~150):
   onGlobalPostsLoaded: (posts) => { globalPosts = posts; rebuild ids; push to app/landing },
   onNewGlobalPost: (post) => { dedup by id; prepend; push to app/landing }.
   Push them to the app via a new app surface — coordinate with the app.ts/feed.ts changes:
   the app element will expose updateGlobalPosts(posts: Post[]) (the UI agent adds it).
   So call (appElement as any).updateGlobalPosts?.(globalPosts) on each global update,
   mirroring refreshFeed().
3. Kick off the load: after the WS connects (onStatusChange 'connected', or right after
   wiring delegate) call connection.loadGlobalIndex() + connection.subscribeGlobalIndex()
   — independent of identity, so it runs for logged-out users too. Make sure it does NOT
   block / race the delegate identity flow.
4. Pre-auth landing: when showOnboarding renders, the public timeline must be visible behind
   the onboarding overlay. The onboarding is a full-screen overlay on document.body. Render a
   read-only public feed UNDER it so the page isn't blank. Simplest correct approach: mount a
   lightweight landing feed (reuse the createFeed/discover render the UI agent exposes, OR a
   minimal read-only list) into appRoot before/under the overlay, fed by updateGlobalPosts.
   Keep it read-only (no compose/like for logged-out users — those need a delegate). When
   renderApp runs (identity known), it replaces the landing with the full app as today.
   Keep changes minimal and reversible; do not break the existing offline-mode block (~443)
   or the delegate timeout path.

Report exactly what you changed and how the landing feed coexists with onboarding.`,
    { label: 'impl:wiring', phase: 'Wiring + UI', model: MODEL },
  ),
  () => agent(
    `Edit ONLY ${ROOT}/web/src/app.ts and ${ROOT}/web/src/components/feed.ts. Do NOT touch
index.ts or freenet-api.ts.

${wiringSummary}

SCOUT FACTS:
${F}

Render the global-index public timeline in the Home feed's Discover tab (currently a dead
"Discover is quiet right now" stub in feed.ts ~105). Also expose an app-level surface index.ts
can push global posts to.

feed.ts:
1. createFeed keeps the Following tab as-is (own/user-shard posts via the existing currentPosts).
2. Add a second backing array: let discoverPosts: Post[] = []. The Discover tab branch in
   renderPosts (~105) must render discoverPosts with createPostCard (same as the following
   branch), NOT the stub. If discoverPosts is empty, show a friendly empty note
   ("No public posts yet" / "Public posts from across the network will appear here").
3. Add to the returned feedEl a method updateDiscoverPosts(posts: Post[]) that sets
   discoverPosts and re-renders IF the discover tab is active (mirror updatePosts ~168).
4. Discover posts are read-only-ish but may still like/repost/quote if a delegate exists —
   wire the same callbacks as Following (onLike/onRepost/onQuote/onOpen). The post-card already
   degrades gracefully when actions can't be signed.

app.ts:
5. createApp: expose appEl.updateGlobalPosts(posts: Post[]) that forwards to
   feed.updateDiscoverPosts(posts) (mirror updatePosts ~158). Add the method to the
   appEl type cast (~153).
6. Do not change the Following-tab data flow.

Keep style consistent with the file. TypeScript strict must pass. Report the exact new methods
and the Discover render branch you wrote.`,
    { label: 'impl:ui', phase: 'Wiring + UI', model: MODEL },
  ),
])

// ---------------------------------------------------------------------------
// Phase 4 — Tests. Depends on the final API surface. Mirrors the existing
// vitest harness in freenet-api.test.ts.
// ---------------------------------------------------------------------------
phase('Tests')
const testRes = await agent(
  `Add vitest coverage for the global-index READ path in ${ROOT}/web/src/freenet-api.test.ts.
Edit ONLY that test file. Match the existing harness style (mock WS / simulated GET responses).

API surface added (Phase 2):
${apiResult}

SCOUT FACTS (incl. a representative existing test):
${F}

Add tests, mirroring how the existing user-shard GET tests work:
1. A GET response routed to the global-index instance id (state {"posts":{"<id>":<ContractPost>}})
   triggers onGlobalPostsLoaded with the posts mapped + sorted newest-first.
2. An empty index ({"posts":{}}) yields onGlobalPostsLoaded([]).
3. A live update notification with delta {"Posts":[<ContractPost>]} on the global-index key
   triggers onNewGlobalPost with the mapped post.
4. Routing isolation: a global-index GET response must NOT fire onPostsLoaded (the user-shard
   callback) and vice-versa — confirm the new branch doesn't shadow user-shard/thread routing.
5. Offline/dev (no code hash → globalIndexKeyOrNull null): loadGlobalIndex() is a no-op
   (no GET sent, no throw).

Keep tests deterministic. They must pass under \`cargo make test\` (vitest). Report the test
names you added.`,
  { label: 'impl:tests', phase: 'Tests', model: MODEL },
)

// ---------------------------------------------------------------------------
// Phase 5 — Gate. Run the real pre-push gate and fix failures. This is the
// barrier: nothing reviews until it's green.
// ---------------------------------------------------------------------------
phase('Gate')
const gateRes = await agent(
  `Run the full pre-push quality gate for ${ROOT} and FIX any failures introduced by the
global-index read/render change (freenet-api.ts, index.ts, app.ts, feed.ts, freenet-api.test.ts).

Run, in order, and fix until green:
1. cd ${ROOT}/web && tsc / the project's typecheck (use \`cargo make check\` if that is the
   tsc gate — inspect Makefile.toml to confirm the exact task name).
2. cargo make test   (vitest — the web suite, includes the new tests)
3. cargo make clippy  (deny warnings — only relevant if any Rust changed; the contract should
   NOT have changed in this PR, so flag it if it did)
4. cargo make fmt-check

If a gate fails, read the error, fix the offending file (stay within the five files above plus
any genuinely required import), and re-run that gate. Do NOT weaken tests to pass. Do NOT modify
the global-index CONTRACT (Rust) — this is a UI-only PR; if something pushes you toward a contract
edit, stop and report it instead.

Report: final status of each gate (pass/fail + the command), and a list of every fix you made.`,
  { label: 'gate', phase: 'Gate', model: MODEL },
)

// ---------------------------------------------------------------------------
// Phase 6 — Adversarial review panel. Three lenses in parallel over the final
// diff, then a synthesis. Each is told to assume bugs exist.
// ---------------------------------------------------------------------------
phase('Review')
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'verdict'],
  properties: {
    verdict: { type: 'string', enum: ['ship', 'fix-needed', 'block'], description: 'Overall lens verdict.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'issue'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          issue: { type: 'string', description: 'What is wrong and why, with line/symbol.' },
          fix: { type: 'string', description: 'Concrete suggested fix.' },
        },
      },
    },
  },
}
const diffCmd = `git -C ${ROOT} diff` // reviewers run this themselves

const lenses = [
  {
    key: 'correctness',
    prompt: `Adversarial CORRECTNESS review of the global-index read/render change in ${ROOT}.
Run \`${diffCmd}\` to see all changes. Assume bugs exist until proven otherwise.

Verify against intent: GET the singleton global index → parse {"posts":{id:Post}} MAP → map to
UI posts sorted newest-first → onGlobalPostsLoaded → Discover tab + pre-auth landing render; live
{"Posts":[...]} deltas → onNewGlobalPost. Check:
- Is the state parsed as a MAP (Object.values) not a Vec? A Vec parse would silently yield [].
- Does the GET routing in handleGetResponse correctly distinguish global-index vs user-shard vs
  thread instance ids? Could the new branch shadow or be shadowed by the others (wrong feed gets
  the posts, or global posts land in the Following feed)?
- contractPostToUiPost field mapping correct for index posts (author_pubkey, timestamp ms→Date)?
- Does loadGlobalIndex correctly no-op offline (null key) without sending a GET or throwing?
- Reader must NOT instantiate/PUT the singleton — confirm no ensure/PUT on the read path.`,
  },
  {
    key: 'races',
    prompt: `Adversarial RACE / EDGE-CASE review of the global-index read/render change in ${ROOT}.
Run \`${diffCmd}\`. Assume concurrency bugs exist.

The codebase serialises GETs (getChain) because the stdlib has NO request correlation — the Nth
response settles the Nth pending get(). Check:
- Does loadGlobalIndex go through serializedGet (the chain), or does it call api.get directly and
  break the no-two-GETs-outstanding invariant? A raw api.get could swap responses with the
  user-shard/thread probes (the exact M-class hazard documented in the file).
- The pre-auth landing + logged-in app both consume global posts. On the onboarding→app transition
  (renderApp), is the landing feed cleanly replaced? Any double-render, leaked listener, or
  updateGlobalPosts call against a torn-down element?
- subscribeGlobalIndex live deltas arriving before/after the initial GET — dedup correct? Does
  onNewGlobalPost dedup by id (globalPostIds) so a post in both the snapshot and a delta isn't
  duplicated?
- globalIndexInstanceId set lazily inside globalIndexKeyOrNull — is it guaranteed set before the
  first GET response is routed? If loadGlobalIndex derives the key, instanceId is set; but the
  routing in handleGetResponse reads globalIndexInstanceId — confirm ordering.`,
  },
  {
    key: 'plan',
    prompt: `PLAN-ALIGNMENT + scope review of the global-index read/render change in ${ROOT}.
Run \`${diffCmd}\`.

Intended scope (user-confirmed): UI read/render side of PR #49's global index. Pattern: logged-out
users see the public timeline as the landing surface (behind onboarding); logged-in users get it in
the Home feed's Discover tab. UI-ONLY — the Rust contract must NOT change.
Check:
- Did anything touch the global-index CONTRACT (contracts/global-index-shard/) or other Rust? It
  must not — flag any Rust diff as a scope violation.
- Is the Discover tab actually wired to real data (not still the stub)? Is the pre-auth landing
  actually rendering for logged-out users?
- Were committed release artifacts (published-contract/, web/dist/) accidentally modified? Flag if so.
- Any dead code, unused new callback, TODO left, or stub not replaced?
- Does it stay minimal — no gratuitous refactor of unrelated code?`,
  },
]

const reviews = await parallel(
  lenses.map((l) => () =>
    agent(l.prompt, { label: `review:${l.key}`, phase: 'Review', model: MODEL, schema: REVIEW_SCHEMA })
      .then((r) => ({ lens: l.key, ...(r || { verdict: 'block', findings: [] }) })),
  ),
)

return {
  scout: F.slice(0, 400) + (F.length > 400 ? ' …' : ''),
  apiResult,
  wiringRes,
  uiRes,
  testRes,
  gateRes,
  reviews,
}
