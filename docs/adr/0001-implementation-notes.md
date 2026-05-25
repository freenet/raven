# ADR-0001 implementation notes

Working notes for the staged implementation of
[ADR-0001](0001-contract-sharding-architecture.md). The ADR is the design;
this file records the concrete engineering decisions and sequencing so the
work can land in reviewable slices instead of one monolithic change.

## Scope and sequencing

The ADR spans #11 (profiles), #12 (threads), #13 (per-user feeds), and #19
(fanout, still open). It is built **one shard type at a time**, and the
migration from today's global contracts is **not wired until all shard types
exist**. Order:

0. **Crypto + id foundation** (this slice) — prerequisites shared by every shard.
1. **User shard** — per-user, owner-writes-only (profile + recent posts + follows).
2. **Thread shard** — per-root, public-write (replies + likes + quote refs).
3. **Inbox shard** — per-user, public-write notifications; owner prunes.
4. **Migration** — cut existing global state over to the shards.

## Phase 0 decisions

### Signature scheme: ML-DSA-65 (post-quantum)

Raven moves from Ed25519 to **ML-DSA-65** (FIPS 204, NIST level 3), matching
`freenet/freenet-email`. Pin `ml-dsa = =0.1.0-rc.8` (build-isolation rule:
exact version, see AGENTS.md → "Build isolation").

Size changes that ripple through the code:

| | Ed25519 | ML-DSA-65 |
|---|---|---|
| secret (stored seed) | 32 B | **32 B** (unchanged — a seed) |
| verifying key (VK) | 32 B | **1952 B** |
| signature | 64 B | **3309 B** |

Consequences:
- The stored secret is still a 32-byte seed, so export/import stays a 64-hex
  string. The signing key is reconstructed with `MlDsa65::from_seed(seed)`.
- **The VK is no longer derivable from the seed by string-slicing.** The web UI
  (`web/src/identity.ts`) currently does `publicKey = secretKey.slice(0,64)`;
  that assumption is removed — the delegate is the sole source of the VK, and
  the UI waits for the delegate's `Identity` response on import.
- In the WASM delegate the seed comes from `freenet_stdlib::rand::rand_bytes(32)`
  (no `getrandom` in WASM), reconstructed via `MlDsa65::from_seed`.

### Post id: content hash of the signed record

Post id moves from the string `"{author_pubkey}-{timestamp_ms}"` (collides
within a millisecond, forgeable, not self-describing) to

    id = blake3(canonical_signed_post_bytes)   // 32-byte content address

This satisfies the ADR's Atlas constraint: posts are "self-contained signed
records with stable, externally-referenceable IDs." The id is derived from the
signed bytes, so it is collision-resistant and tamper-evident, and any external
indexer can reference a post without rehydrating internal state.

### Shard key derivation (lands with the user shard, Phase 1)

A shard contract is parameterized by its owner's **ML-DSA-65 VK bytes**:

    parameters     = owner_vk_bytes
    contract_key   = ContractKey::from_params(shard_wasm_hash, parameters)
                   = blake3(wasm_code || parameters)   // native freenet derivation

No custom hash primitive is introduced. Domain separation between shard types
(`"user"` / `"thread"` / `"inbox"` in the ADR table) comes for free from the
distinct WASM code hash of each shard binary — two shard types never share a
binary, so the same owner VK yields three different contract keys.

### Posts contract now self-verifies (and what that means for old data)

The existing global `posts` contract is updated in this phase to use
`common::post::Post`: `update_state` / `validate_state` now **reject any post
that does not self-verify** (content-addressed id + valid ML-DSA-65 signature
for `author_pubkey`) or exceeds the length bound. A bad post in a delta batch is
skipped, not fatal to the whole update.

This is a **non-byte-compatible schema change** (`signature` moves from a byte
array to a hex string; `id` moves from a `{pubkey}-{ms}` string to a content
address), so per AGENTS.md → "Contract migration" it cannot ride a plain
hash-bump legacy append. It does not need a re-shape pass either: the only
pre-existing posts are **unsigned** prototype data (`signature: null`), which by
definition can never satisfy the new signed invariant and are intentionally not
carried across. The posts WASM hash rotates on the next `cargo make
build-contracts`; no entry is added to `LEGACY_POSTS_CODE_HASHES` because there
is no migratable prior state. Signed-feed migration proper arrives with the
shard cutover (Phase 4).

## Phase 1 decisions (user shard)

The user shard (`contracts/user-shard`) lands **posts-only** first; profile and
follows are deferred to follow-up slices (they share the owner-writes / low-churn
/ read-by-followers axis, so they belong in this same contract — they are not
new contract types). The contract reuses the merge/summary machinery proven on
the `posts` contract, adding two shard-specific rules:

### Write authority — VK-param match

The shard is parameterized by the **raw encoded owner ML-DSA-65 VK bytes**
(`parameters = vk.encode()`). `update_state` / `validate_state` accept a post
iff it self-verifies (`common::post::Post::verify`) **and** its `author_pubkey`
hex equals `hex(parameters)`. A post signed by a *different* valid key
self-verifies but is not the owner's, so it is rejected — this is what makes the
shard owner-writes without a separate signed-envelope type (the `Post` already
carries the ML-DSA-65 signature). Empty parameters yield an empty owner key that
no real post can match, so an un-parameterized shard accepts nothing.

This realizes the deferred key-derivation primitive: `contract_key =
blake3(user_shard_wasm || owner_vk_bytes)` via native freenet derivation. No
custom hash; domain separation between shard types comes from the distinct WASM
code hash per shard binary (Phase 0 note).

### Bounded state — post-merge count window

`MAX_POSTS = 200` (ADR starting policy). Truncation is **post-merge**, not a
pre-write check, and **count-based with a deterministic total order** — a
contract has no clock (see windowing caveat below). The survival order is
`(timestamp, id)` descending: timestamp is the author-supplied recency hint
(safe to trust here — the shard is single-author owner-writes, so a lying owner
only reorders their own feed), and the content-addressed `id` is a stable total
tie-break so every replica truncates to the identical set regardless of the
order deltas arrived in (covered by `truncation_is_deterministic_across_orderings`).
`validate_state` deliberately does **not** enforce the window — a transiently
over-bound merged state is normal and rejecting it would break convergence;
authority + self-verification are the only validity invariants.

No instance id is committed for this contract (unlike `posts`/`follows`/`likes`,
which use empty parameters): per-owner parameterization means each owner derives
a distinct key at runtime from the one build-stable `user_shard_code_hash`. UI
wiring + migration of the existing global feed into per-user shards is Phase 4.

### Phase 1b — profile + follows (completes the user shard)

The user shard now carries all three owner-writes surfaces. State is
`{ posts, profile: Option<ProfileRegister>, follows: BTreeMap<vk, FollowState> }`.

**Non-post owner mutations use a signed envelope** (`common::signed_op::SignedOp`):
profile and follow edits are not `Post`s, so they carry no intrinsic signature.
`SignedOp` is an ML-DSA-65 signature by the owner over a domain-tagged
(`raven:signed-op:v1`, distinct from the post tag), length-prefixed payload of
`(op_type, payload, seq, signer_pubkey)`. `op.verify(owner)` checks the signer is
the owner *and* the signature is valid — the same VK-param match as posts. The
generic envelope is reused for all three op types (`Profile` / `Follow` /
`Unfollow`); `op_type` and `seq` are inside the signed bytes so an op cannot be
replayed against another surface or have its `seq` bumped to win a race.

**Convergence per surface** (all order-independent — required because deltas
arrive in any order across replicas):
- *profile* — last-write-wins by monotonic `seq`, tie-broken by serialized bytes
  (no clock in a contract; the delegate supplies a monotonic counter).
- *follows* — each target key stores the `seq` of the op that last touched it and
  whether it was a Follow; merge keeps the higher `seq` per key, and on **equal
  seq an Unfollow wins** (a deterministic tie-break). This is convergent under
  reordering, unlike the bare add/remove set in the legacy global `follows`
  contract (whose own NOTE admits Follow/Unfollow is not commutative). The
  equal-seq tie-break is load-bearing: without it, concurrent Follow/Unfollow at
  the same seq splits replicas permanently (review C-1).

The envelope is **bound to a shard context** (`USER_SHARD_CONTEXT =
"raven:user-shard:v1"`) mixed into `signing_payload`, so a future thread/inbox
shard reusing `SignedOp` cannot have a user-shard op replayed into it (review
M-2). Follows are also bounded — `MAX_FOLLOWS` map entries, `MAX_FOLLOW_TARGETS_
PER_OP` per op, and a target-key length cap — so an owner cannot self-bloat the
shard (review M-1). The cap is applied **post-merge by `truncate_follows` as a
function of the key set** (tombstones evicted first, then largest key), never by
arrival order: an earlier draft skipped new keys at insert time, which made the
retained set order-dependent and split replicas permanently at the cap (review
MAJOR-1, fourth round — the same convergence class as C-1). Over-cap eviction is
best-effort lossy, the same trade-off as the recent-N post window. Evicting
tombstones first also bounds tombstone accumulation (review NIT).

**Delta format is now a tagged `ShardDelta` enum** (`Posts(Vec<Post>)` |
`Op(SignedOp)`), forced by review finding MAJOR-2: the Phase-1 bare-`Vec<Post>`
delta could not host a second surface, and changing it later (after non-test
state exists) would need a migration. `update_state` now iterates **every**
`UpdateData` item (not just `delta[0]`) and the `State`/`StateAndDelta` arms do a
real full-`UserShard` merge (so a peer syncing state reconciles profile + follows,
not only posts). `apply_delta_bytes` still accepts a bare `Vec<Post>` for
backward tolerance. `summarize_state` folds profile + follows into one hash each
so a register difference triggers a delta; `get_state_delta` ships the full state
when a register differs (a `Posts` delta cannot convey registers) and just the
missing posts otherwise.

**Review fixes folded in** (from the post-merge re-review of #25): `validate_state`
now also rejects duplicate post ids (MAJOR-1 — the invariant `update_state`'s
dedup guarantees, so the two halves agree) and oversized profile fields;
`summarize_state`/`get_state_delta` use `?` instead of `unwrap()` (MINOR-3,
panic-in-WASM footgun); `MAX_CONTENT_LEN` doc corrected to say bytes, not chars
(NIT). The window is still deliberately not enforced in `validate_state`.

This rotates the user-shard WASM hash again; still no migration entry (no
migratable prior state — Phase 1 shipped no real user-shard data). UI wiring is
still Phase 4.

## Phase 2 decisions (thread shard)

The thread shard (`contracts/thread-shard`) is the first **public-write** shard:
one contract per root post, created lazily on the first reply, collecting the
**replies, likes, and quote references** that target that root. It is
parameterized by the root post's content-addressed id (`parameters =
root_post_id`), so `contract_key = blake3(thread_shard_wasm || root_post_id)` —
distinct per thread and, because the WASM hash differs, distinct from a user
shard parameterized by the same bytes.

### Write authority — anyone-writes, self-verifying, credential seam

Unlike the owner-writes user shard, a thread shard accepts writes from **any**
party. Each entry still self-verifies:

- a **reply** is a full `common::post::Post` whose `reply_to` equals this
  thread's root id. `reply_to` is **conditionally mixed into the post signing
  payload** (only when non-empty — see below), so a reply's thread membership is
  signed and cannot be replayed into another thread; a top-level post (empty
  `reply_to`) hashes/signs exactly as before, leaving existing post ids/sigs
  byte-stable.
- a **like** is a `common::thread::LikeRecord` and a **quote ref** a
  `common::thread::QuoteRef`, each an ML-DSA-65 signature over a domain-tagged
  (`raven:thread-like:v1` / `raven:thread-quote:v1`), length-prefixed payload
  **including the root post id**, so neither can be replayed into another thread.

Verification proves *who* signed, not that the signer is *allowed* — the ADR's
abuse model leaves "who may be a writer" to a credential mechanism (GhostKey is
the candidate, not fixed). Per the Phase 2 decision, the wire slot is reserved
now: every record carries an optional `WriterCert`, and the contract gates writes
through a `verify_writer_cert` seam that **accepts everything today**. When a real
credential lands, only that seam changes — an additive schema step, not a format
break. (The user shard does not reuse `signed_op::SignedOp` here: `SignedOp` is
owner-bound — its `verify` rejects any signer ≠ owner — which is exactly wrong
for an anyone-writes surface, so thread records carry their own self-sig.)

### Convergence per surface (order-independent — AGENTS.md → "Contract correctness invariants")

- *replies* — grow-set deduped by content-address id, truncated post-merge to the
  newest `MAX_REPLIES` (500) by `(timestamp, id)` desc (a total order; no clock).
- *likes* — per-liker join semilattice keyed by liker VK: keep the higher `seq`,
  and on equal `seq` an **unlike wins** (the same deterministic tie-break as the
  user-shard follows, for the same reason — equal-seq concurrent like/unlike must
  not split replicas). Capped post-merge by `truncate_likes` as a function of the
  key set (tombstones evicted first, then largest key).
- *quotes* — grow-set deduped by `quote_post_id`, capped post-merge by a total
  order over the key.

All caps are enforced **only post-merge** (`normalize`), never at insert time;
`validate_state` deliberately does not enforce them (a transiently over-bound
merged state is normal). `validate_state` *does* reject any reply/quote that
fails self-verification, is not thread-bound, or is mis-keyed (id ≠ map key), and
any liker key that is not a valid-length ML-DSA-65 VK — the invariants
`update_state` guarantees, so the two halves agree.

### Delta format and sync

Deltas are a tagged `ThreadDelta` enum (`Replies` | `Likes` | `Quotes`).
`update_state` iterates **every** `UpdateData` item and the `State` /
`StateAndDelta` arms do a full-`ThreadShard` merge, so a peer syncing state
reconciles all three surfaces. `summarize_state` returns the per-surface key sets
(plus each like's `(seq, liked)` for diffing), and `get_state_delta` ships a
`ThreadStateDelta` carrying exactly what the requester lacks: full self-verifying
records for **all three** surfaces, including likes. `apply_delta_bytes` decodes
`ThreadStateDelta` too, so the sync delta round-trips (regression:
`get_state_delta_output_is_applyable`).

**Likes store the full signed `LikeRecord`, re-verified on every path.** A
public-write contract must assume adversarial `UpdateData`, so a like is re-checked
by `merge_like` (→ `LikeRecord::verify`) on *every* write path — `ThreadDelta::Likes`,
full-state `merge_state`, and the sync `apply_state_delta` — and `validate_state`
re-proves every stored like's signature. There is no "the sender already verified
it" shortcut: an earlier draft stored likes as unsigned `(seq, liked)` and trusted
the full-state / sync paths, which let *any* peer forge, suppress, or overwrite any
user's like with no private key (review **CRITICAL**, fifth round — a signature
bypass, the same "every write path must verify, not just the primary one" lesson as
the convergence rounds). Retaining the signature (~3.3 KB/like) is the price of an
unforgeable per-liker counter on a public surface. Replies and quotes always worked
this way; likes were the lone exception and now match. `merge_state` likewise
re-verifies replies/quotes (it had trusted them) so a full-state sync cannot inject
anything a delta could not (review M-1).

This adds the `thread_shard_code_hash` build artifact (parameterized, so no single
instance id — like the user shard). No migration entry (no prior thread-shard
state). UI wiring + cross-contract quote/notification delivery are Phase 4 / the
inbox shard (Phase 3).

## Phase 3 decisions (inbox shard)

The inbox shard (`contracts/inbox-shard`) is the **last shard type**: one contract
per user, parameterized by the owner's ML-DSA-65 VK bytes (`parameters =
owner_vk_bytes`, exactly like the user shard), so `contract_key =
blake3(inbox_shard_wasm || owner_vk)` — distinct per user and, because the WASM
hash differs, distinct from that user's user shard with the same parameters. It
holds incoming **notifications** (reply / mention / follow / quote) targeting the
owner.

### Write authority — anyone-writes deliveries, owner-prunes

The inbox is the second public-write surface, but with a twist absent from the
thread shard: it is **anyone-writes for delivery, owner-only for pruning**.

- A **notification** (`common::inbox::Notification`, kind
  `Reply`/`Mention`/`Follow`/`Quote`) is signed by its **sender** and bound to
  the **recipient owner VK** (domain tag `raven:inbox-notif:v1`, recipient +
  kind mixed into the length-prefixed payload), so it self-verifies and cannot
  be replayed into another user's inbox or presented as a different kind. Its
  `id` is the content address `blake3(signing_payload)`, the map key and the
  handle the owner names when pruning one. As on the thread shard, *who* may be a
  sender is the abuse question left to a credential mechanism — the `WriterCert`
  slot is reserved and gated by `verify_writer_cert` (accepts everything today).
- A **prune** reuses the owner-bound `signed_op::SignedOp` envelope (the same
  type the user shard uses for profile/follows) under a new
  `INBOX_SHARD_CONTEXT = "raven:inbox-shard:v1"`, so an inbox prune cannot be
  replayed into the user shard or vice versa. Two new `OpType`s were added:
  `PruneIds` (drop explicit ids in the payload — selective) and `PruneBefore`
  (advance a high-water to `op.seq` — bulk). `SignedOp::verify` already requires
  `signer == owner`, so only the owner can prune.

### The owner-prune convergence invariant (the hard part)

On an anyone-writes surface, the new failure mode is **resurrection**: a stale
replica still holding a notification the owner pruned must not re-add it when it
merges with a pruned replica. A prune therefore leaves **durable, convergent
evidence**, and state is `{ notifs, tombstones: Map<id,owner_seq>, pruned_before:
u64 }`:

- *pruned_before* — a single monotonic high-water, merged **max-wins**. Any notif
  with `seq < pruned_before` is dropped on every path and never re-admitted.
- *tombstones* — a grow-set of selectively-pruned ids, merged by max owner-seq per
  id. A tombstoned id is dropped on every path.
- *notifs* — a grow-set keyed by content address, admitted only if it
  self-verifies for this owner **and** is neither tombstoned nor below the
  high-water (`notif_admissible`, the single predicate every write path and
  `validate_state` agree on).

The hybrid (selective ids + bulk high-water) is what keeps tombstones from growing
unbounded: the high-water collapses the common case (clear-everything-older), and
explicit tombstones only persist for ids newer than the water line. `normalize`
re-applies prune suppression **post-merge** (the same discipline as the caps), so
a notif that arrived before the prune that suppresses it — i.e. the prune merged
in second — is still removed. Notifs are capped post-merge to the newest
`MAX_NOTIFS` by `(seq, id)` desc (a total order; no clock).

### Sync delta carries prune evidence (removal-only, so trusting it is safe)

`summarize_state` ships the notif id set + prune position; `get_state_delta` ships
the full self-verifying notifications the requester lacks **plus** the
`tombstones` + `pruned_before` evidence. That evidence is **not individually
re-signed** in the delta — it is the *result* of owner prune ops the source
already verified. This is the one deliberate asymmetry vs. the thread shard's
"re-verify everything" rule, and it is sound because trusting a peer's claimed
prune position can only ever **remove** notifications, never add or forge one:
the notifications themselves are still re-verified by `merge_notif` on every path
(`apply_state_delta`, `merge_state`), so a forged *addition* is impossible, and
removal is monotone and convergent. The worst a lying peer can do over sync is
hide notifications from a replica that syncs *from* it — never inject one, and
never affect a replica that does not sync from it. (Documented inline on
`apply_state_delta` so a future reviewer does not "fix" it into re-verification of
unsigned evidence, which would break high-water convergence.)

`validate_state` re-proves every stored notification is admissible — including
that it is **not** tombstoned and **not** below the high-water — so a forged
resurrection in a state object fails validation (the two halves agree, the
thread-shard CRITICAL lesson applied to the inbox).

This adds the `inbox_shard_code_hash` build artifact (parameterized, so no single
instance id — like the user and thread shards). No migration entry (no prior
inbox-shard state). With this slice **all three shard types now exist**, so the
migration + UI wiring (Phase 4) is unblocked.

## Testing tiers

- **Unit** — per-function `#[test]`s inside each contract crate's `test` module:
  one `validate_state` / `update_state` / merge / truncation rule at a time, with
  real ML-DSA-65 keys. The convergence and forgery regressions live here.
- **Integration** — an `integration` module inside the user-shard and thread-shard
  crates that drives the **full `ContractInterface` through the real sync
  protocol**: a `sync_into` helper does `dst.summarize_state` →
  `src.get_state_delta(summary)` → `dst.update_state(delta)` and asserts `dst`
  stays valid, and `reconcile` runs it both directions and asserts the two
  replicas reach byte-identical state. This covers what unit tests skip — the
  summarize/delta wire path and the validate-after-merge invariant — across
  multi-replica convergence (incl. equal-seq follow/unfollow and like/unlike
  fixed points in both reconcile orders), adversarial-replica rejection (a forged
  like / non-owner post in a peer's state must not propagate to an honest
  replica), and cross-shard key consistency (a user-shard post's content id is the
  thread-shard param, and a reply bound to it lands only on that thread).
- **Deferred — WASM-in-node e2e**: these integration tests drive the contract as a
  Rust library, not the compiled WASM inside a running node, so they do not catch
  WASM-compilation or transport differences. A real-node tier (via the
  `freenet:linux-test` / `freenet:local-dev` skills — publish the shards, drive
  reply/like/quote + two-peer sync over the live WS) is the next testing slice;
  it is heavier and not a per-PR CI fit. The identity delegate also still lacks
  unit coverage (deferred from Phase 0).

`cargo make test` now runs `cargo test --workspace` (was a hand-maintained subset
that omitted the user/thread shards and the delegate) so every crate — and these
integration tests — run in CI.

## Caveat: ADR vs. mail on windowing

The ADR states the bounded-state window mirrors "how `freenet/mail` windows its
inbox contracts." On inspection, the mail **inbox contract does no
contract-level truncation** — it bounds nothing in `update_state`; mail enforces
message age sender-side in the anti-flood-token delegate, because there is no
clock inside the contract WASM. So Raven's post-merge truncation is **new code**,
not a port, and it must be **count-based with a deterministic ordering** (by post
id) rather than time-based — a contract cannot read a wall clock. This is the
only material place the implementation diverges from the ADR's stated rationale.
