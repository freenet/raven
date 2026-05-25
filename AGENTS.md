# Freenet Microblogging – Agent Guide

## Overview

Decentralized Twitter/X-like microblogging application built on Freenet. Uses a
TypeScript web UI with Vite, Rust WASM contracts for post storage and social
graph, an Ed25519 identity delegate for signing, and the `@freenetorg/freenet-stdlib`
TypeScript SDK for WebSocket communication with a Freenet node.

## Quick Reference

### Commands

```bash
# Build
cargo make build                # Full build: contracts + UI + web container
cargo make build-contracts      # Posts + follows + likes + identity (WASM + code hashes)
cargo make build-ui             # Vite/TypeScript build (depends on build-contracts)
cargo make build-web-container  # web/container Rust → WASM
cargo make build-ui-offline     # Vite build with mock data (no Freenet node) — for CI

# Publish (local node)
cargo make publish-posts        # Publish posts contract
cargo make publish-follows      # Publish follows contract
cargo make publish-likes        # Publish likes contract
cargo make publish-identity     # Publish identity delegate
cargo make publish-webapp-test  # Publish test-signed webapp from published-contract/
cargo make publish-all          # End-to-end: build → sign-test → snapshot → publish all

# Publish (PRODUCTION — use scripts/release.sh, not directly)
cargo make publish-production   # Build → sign with prod key → snapshot → publish to live network

# Release
scripts/release.sh 0.1.0        # End-to-end release driver (preflight + 3 confirmation gates)

# Development
cd web && npm run dev           # Vite dev server on :8080
cargo make dev-offline          # Vite dev server with mock data (no node required)

# Quality
cargo make test                 # Rust tests + Vitest
cargo make clippy               # Workspace clippy, deny warnings
cargo make fmt-check            # cargo fmt --check
cargo make check                # cargo check + tsc --noEmit

# Playwright
cargo make test-ui-playwright-setup  # One-time browser install
cargo make test-ui-playwright        # Run E2E suite

# Node
cargo make run-node             # Local Freenet node
```

### Repository Structure

```
freenet-microblogging/
├── contracts/
│   ├── posts/                  # Posts contract (Rust → WASM)
│   │   ├── src/lib.rs          # PostsFeed: store, validate, merge posts
│   │   ├── Cargo.toml
│   │   ├── freenet.toml
│   │   └── initial_state.json  # {"posts": []}
│   └── follows/                # Follows contract (Rust → WASM)
│       ├── src/lib.rs          # FollowGraph: follow/unfollow actions
│       ├── Cargo.toml
│       ├── freenet.toml
│       └── initial_state.json  # {"follows": {}}
├── delegates/
│   └── identity/               # Identity delegate (Rust → WASM)
│       ├── src/lib.rs          # Ed25519 keypair, signing
│       ├── Cargo.toml
│       └── freenet.toml
├── web/                        # TypeScript web frontend
│   ├── index.html              # App entry point (Vite serves this)
│   ├── vite.config.ts          # Vite bundler config
│   ├── src/
│   │   ├── index.ts            # Entry: mounts app shell
│   │   ├── app.ts              # App shell: assembles 3-column layout
│   │   ├── types.ts            # Post, User, TrendingTopic interfaces
│   │   ├── mock-data.ts        # Mock posts/users for development
│   │   ├── theme.ts            # Dark/light mode toggle
│   │   ├── utils.ts            # formatRelativeTime helper
│   │   ├── vite-env.d.ts       # Vite type declarations
│   │   ├── components/
│   │   │   ├── sidebar.ts      # Logo, nav, theme toggle, post CTA
│   │   │   ├── feed.ts         # Tab bar, compose, post list, filtering
│   │   │   ├── compose-box.ts  # Textarea, char counter, post button
│   │   │   ├── post-card.ts    # Post card with actions, timestamps
│   │   │   ├── right-panel.ts  # Search, trending, who-to-follow
│   │   │   └── bottom-nav.ts   # Mobile bottom navigation
│   │   └── scss/
│   │       ├── styles.scss     # Main entry (imports all partials)
│   │       ├── _variables.scss # CSS custom properties (design tokens)
│   │       ├── _reset.scss     # Minimal reset
│   │       ├── _layout.scss    # 3-column grid
│   │       ├── _sidebar.scss   # Sidebar styles
│   │       ├── _feed.scss      # Feed, compose, post cards
│   │       ├── _right-panel.scss # Trending, follow cards
│   │       ├── _buttons.scss   # Button variants
│   │       ├── _dark-mode.scss # Dark mode overrides
│   │       └── _responsive.scss # Mobile/tablet breakpoints
│   ├── container/              # Web contract container (Rust → WASM)
│   │   └── src/lib.rs
│   ├── package.json
│   ├── tsconfig.json
│   └── freenet.toml
├── Cargo.toml                  # Workspace root
├── Makefile.toml               # Build orchestration (cargo-make)
├── DESIGN.md                   # Visual design system specification
├── CLAUDE.md                   # → points to this file
└── AGENTS.md                   # This file (single source of truth)
```

### Key Dependencies

| Dependency | Purpose |
|-----------|---------|
| `@freenetorg/freenet-stdlib` | Freenet TypeScript SDK — WebSocket API, FlatBuffers types |
| `vite` | Build tool and dev server |
| `vitest` | Test runner |
| `typescript` | Language |
| `sass` | SCSS compilation |
| `freenet-stdlib` (Rust) | Contract/delegate traits, WASM macros |
| `ed25519-dalek` (Rust) | Ed25519 signing for identity delegate |
| `freenet` (cargo) | Freenet node binary |
| `fdev` (cargo) | Freenet developer tools (build, publish, inspect) |

### Architecture

- **Posts Contract** (`contracts/posts/`): Rust WASM contract storing microblog
  posts as JSON. Each post has id, author_pubkey, author_name, author_handle,
  content (max 280 chars), timestamp, and optional signature. Merge is
  commutative: dedup by post hash (Blake3 of id).

- **Follows Contract** (`contracts/follows/`): Rust WASM contract storing the
  social graph as `HashMap<pubkey, HashSet<pubkey>>`. Supports Follow/Unfollow
  actions. Merge is commutative for follows (set union).

- **Identity Delegate** (`delegates/identity/`): Runs locally on user's device.
  Generates/stores Ed25519 keypairs via Freenet's encrypted secret storage.
  Signs post content on request. Communicates with web UI via ApplicationMessage.

- **Web Container** (`web/container/`): Minimal Rust WASM contract serving the
  compiled web app as a Freenet webapp.

- **Web App** (`web/src/`): TypeScript SPA with Vite. Twitter/X-like 3-column
  layout (sidebar / feed / right panel). Components: sidebar nav, compose box
  with 280-char limit, post cards with like/repost/reply actions, trending
  topics, who-to-follow suggestions, dark mode toggle, responsive design with
  mobile bottom nav and FAB.

### Build Flow

```
contracts/{posts,follows,likes}/src/lib.rs
    → fdev build → WASM
    → fdev inspect → code hash → build/<name>_code_hash
    (posts hash also mirrored to web/model_code_hash.txt for vite.config.ts)

delegates/identity/src/lib.rs
    → fdev build --package-type delegate → WASM
    → b3sum-derived delegate key → web/delegate_key{,_bytes,_code_hash_bytes}.{txt,json}

web/src/index.ts
    → vite build (defines: __MODEL_CONTRACT__, __DELEGATE_KEY__, __OFFLINE_MODE__)
    → web/dist/

web/dist
    → cargo make compress-webapp → target/webapp/webapp.tar.xz (GNU tar, fixed mtime)
    → cargo make sign-webapp{,-test} → webapp.metadata + webapp.parameters
    → cargo make update-published-contract{,-prod} → published-contract/{wasm,parameters,contract-id.txt}
    → cargo make publish-webapp{,-test} → fdev publish (against committed snapshot)
```

The `published-contract/` directory is committed. CI verifies it matches HEAD.
Production releases bump the snapshot via `scripts/release.sh`.

### Releasing

See `RELEASING.md` for the production release runbook. TL;DR:

```bash
scripts/release.sh 0.1.0
```

Three confirmation gates. Idempotent up to the commit step. The committed
`published-contract/` snapshot is what CI and downstream consumers verify
against, not freshly built artifacts.

### Testing

```bash
cargo make test                                # All tests
cargo test -p freenet-microblogging-posts       # Posts contract (5 tests)
cargo test -p freenet-microblogging-follows     # Follows contract (4 tests)
cd web && npm test                              # Web app (Vitest)
```

### Environment Requirements

- `CARGO_TARGET_DIR` must be set (required by Makefile.toml)
- Node.js and npm for web app
- Rust toolchain with `wasm32-unknown-unknown` target
- `freenet` and `fdev` CLI tools (`cargo install freenet fdev`)

## Contract migration

A contract's WASM hash changes whenever its source or any WASM-affecting
dependency changes, and the contract key is derived from that hash. So a bump
moves every user's state to a new key — stranding the old state unless we
migrate it. The migration system (issue #20) detects a bump on startup and
pulls stranded state into the new key. It runs in `FreenetConnection.connect`
(`web/src/freenet-api.ts`) before subscribing.

### Schema-tolerance policy (MANDATORY)

Every additive field on a contract state struct MUST carry
`#[serde(default, skip_serializing_if = …)]` (or at least `#[serde(default)]`
for non-`Option` fields) so older wire shapes still decode under newer code.
Never put `#[serde(deny_unknown_fields)]` on contract state — unknown
forward-compat fields must be ignored, not rejected.

- Audited structs: `PostsFeed` / `Post` (`contracts/posts/src/lib.rs`),
  `FollowGraph` (`contracts/follows/src/lib.rs`), `LikeGraph`
  (`contracts/likes/src/lib.rs`). Each has a `decodes_old_shape_state` test.
- A schema change that CANNOT be expressed as an additive serde-default field
  (renames, type changes, restructures) is **not** byte-compatible: it needs a
  dedicated re-shape pass in the migration writer and cannot ride a plain hash
  bump.

### Build isolation

Every dependency that influences WASM output is pinned to an exact version
(`=x.y.z`) in each contract/delegate `Cargo.toml` and in the workspace
`freenet-stdlib` entry. The committed workspace `Cargo.lock` pins transitive
deps, and the Rust toolchain is fixed via `rust-toolchain.toml`. Together these
guarantee a routine dependency bump cannot silently rotate a contract's WASM
hash — a rotation is always a deliberate edit.

### Bump recipe (rotating a contract deliberately)

1. Make the change (edit contract source, or bump a `=x.y.z` pin in its
   `Cargo.toml`).
2. Keep the schema byte-compatible — additive serde-default fields only. A
   JSON-schema change in the same release would fail `validate_state` per user;
   split it out with a dedicated re-shape pass.
3. `cargo make build-contracts` to regenerate the WASM + hashes.
4. Append the **prior** hash (the previous current-hash value) to that
   contract's legacy list in `web/src/migrations/legacy-hashes.ts`
   (`LEGACY_POSTS_CODE_HASHES` / `LEGACY_FOLLOWS_CODE_HASHES` /
   `LEGACY_LIKES_CODE_HASHES`). Append-only, oldest → newest — never reorder or
   delete. The new current hash MUST NOT appear in the legacy list (enforced by
   `legacy-hashes.test.ts`).
5. Ship. On next load the migration loop GETs the old key, decodes its state,
   and re-injects it under the new key.

### Helpers

- `web/src/migrations/legacy-hashes.ts` — per-contract legacy lists + current
  hashes (wired from `web/vite.config.ts`) + the `MIGRATABLE_CONTRACTS` registry.
- `web/src/migrations/candidates.ts` — pure `buildMigrationCandidates` /
  `selectMigrateFrom` (ported from mail `ui/src/inbox.rs`).
- `web/src/migrations/state-store.ts` — `MigrationStateStore` (localStorage-
  backed today; a delegate-backed store swaps in for the per-identity era).
- `web/src/migrations/run.ts` — `runMigrations`, the startup loop.

### Deferred (per-identity — lands with #11/#13)

Once profile/posts contracts become per-identity, extend the identity delegate's
secret storage with a `{ contract_type → recorded_hash }` map (mirroring mail's
`AliasInfo`) and run the same `selectMigrateFrom` / candidate-chain / re-inject
flow against each identity's derived key. Cross-version contact interop follows
then.

## Contract correctness invariants (review checklist)

Hard-won rules from the ADR-0001 shard work. Every one of these was a real bug
caught in review (issue refs are the review-round labels). **Check these on any
PR that touches a contract `update_state` / `validate_state` / merge / delta
path** — they pass local tests yet split replicas in production, so unit tests
alone do not catch them.

### Convergence: merges must be order-independent (C-1, MAJOR-1)

A contract's `update_state` runs on every replica with deltas arriving in **any
order**. Any merge rule that depends on arrival order produces a permanent,
non-healing split-brain between replicas.

- **Every per-key / per-element merge must be a pure function of the
  accumulated set**, not of insertion order. Decide the winner from the values
  (seq, content hash, tombstone flag), never from "who arrived first".
- **Equal-rank ties need a deterministic tie-break.** A strict `seq >` is not
  enough: concurrent ops at the *same* seq must resolve the same way on every
  replica (e.g. Unfollow/Unlike wins an equal-seq tie). Without it, two replicas
  that saw the two ops in opposite order disagree forever. (review C-1)
- **Bounded surfaces must truncate post-merge, as a function of the retained
  set** — never by skipping elements at insert time. Admission-order capping is
  arrival-order-dependent and diverges at the cap boundary. Mirror the post
  window: merge everything, then `truncate_*` deterministically (e.g. tombstones
  first, then a total order over keys). Evicting tombstones first also bounds
  tombstone growth. (review MAJOR-1)
- A transiently over-bound merged state is **normal** — `validate_state` must
  NOT enforce the window/cap, or it rejects legitimate merges and breaks
  convergence. Authority + self-verification are the only validity invariants;
  bounds are enforced only by post-merge truncation.

### No clock in a contract

`update_state` cannot read wall-clock time. Any "recent N" / "expire after"
rule must be **count-based over a deterministic total order** (e.g.
`(timestamp, content_id)` desc, where `timestamp` is author-signed data, not a
read clock). Time-based truncation is impossible here — the ADR's "windows like
mail" note is aspirational; mail bounds age sender-side in a delegate.

### Deterministic signing payloads — never `serde_json`

The bytes that are hashed for an id or signed/verified must be a **manual,
length-prefixed concatenation** (`u32` LE len + bytes per field), with a
domain-separation tag first. `serde_json` field order and whitespace are not
guaranteed stable across versions, so a JSON signing payload silently breaks
verification on a dependency bump. See `Post::signing_payload` /
`SignedOp::signing_payload`.

- **Domain-tag every payload** so a signature over one structure can never be
  replayed as a signature over another (`raven:post:v1`, `raven:signed-op:v1`).
- **Bind cross-shard context** for any envelope reused across shard types
  (`USER_SHARD_CONTEXT`), so an op signed for one shard cannot be replayed into
  another that shares the envelope. (review M-2)
- **Append optional signed fields conditionally** (only when non-empty) if you
  must keep existing ids/signatures byte-stable — see `Post::reply_to`. A field
  added unconditionally to a signing payload rotates every existing id/sig.

### `validate_state` must agree with `update_state`

If `update_state` guarantees an invariant (e.g. no duplicate ids), then
`validate_state` must **also reject** a state violating it — otherwise the two
halves disagree and a peer can inject state the updater would never produce.
(review MAJOR-1, #25 re-review)

### Every write path verifies — there is no "trusted" delta (review CRITICAL, #27)

A contract has multiple ways state enters it: `UpdateData::Delta`,
`UpdateData::State` (a full-state merge), `StateAndDelta`, and any sync delta from
`get_state_delta`. **All of them carry attacker-controlled bytes** — a peer can
ship a hand-crafted `State`. So a signed entry must be **re-verified on every one
of those paths**, never only on the "primary" delta path. Do not store a
signature-stripped projection of a signed record and trust that an upstream peer
checked it — that is a forgery primitive on any public-write surface (an unsigned
`(seq, liked)` like let any peer forge/suppress/overwrite any user's like with no
key). Route every path through one verify-then-merge helper, retain the signature
in state, and have `validate_state` re-prove it. If retaining the signature is too
costly, the surface cannot be a self-verifying CRDT and needs a different design —
not a trust shortcut.

### No `unwrap()` / panic in contract WASM

A panic in `update_state` / `validate_state` / `summarize_state` /
`get_state_delta` aborts the WASM trap-style, not a clean error. Use `?` and
return `ContractError`. (review MINOR-3)

### Owner-writes via VK-param match

An owner-writes shard is parameterized by the owner's raw encoded ML-DSA-65 VK
bytes; a write is accepted iff it self-verifies **and** its signer hex equals
`hex(parameters)`. Empty parameters → empty owner key that nothing matches (an
un-parameterized shard accepts nothing — a safe default, not a footgun).

## Conventions

- All Freenet protocol messages use FlatBuffers types from the stdlib
- Contract state is JSON-encoded, transported as `Uint8Array`
- Delta updates are JSON arrays of post/action objects
- WebSocket URL pattern: `ws://{host}/contract/command`
- Contract keys derived from instance ID via `ContractKey.fromInstanceId()`
- CSS follows BEM naming: `block__element--modifier`
- SCSS uses CSS custom properties (design tokens) defined in `_variables.scss`
- Dark mode via `[data-theme="dark"]` attribute on `<html>`
- UI components are pure TypeScript DOM functions (no framework)
- Posts limited to 280 characters (validated in contract + UI)
- ML-DSA-65 (FIPS 204, post-quantum) signatures for post/op authenticity (via
  identity delegate); see ADR-0001 Phase 0. (Was Ed25519 in the prototype.)
