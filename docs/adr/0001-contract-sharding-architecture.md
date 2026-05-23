# ADR-0001: Contract sharding architecture

- **Status:** Accepted
- **Date:** 2026-05-23
- **Deciders:** Raven maintainers
- **Related:** [#8](https://github.com/freenet/raven/issues/8) (tracking), [#16](https://github.com/freenet/raven/issues/16) (per-user vs. global feed), [#18](https://github.com/freenet/raven/issues/18) (thread storage), [#19](https://github.com/freenet/raven/issues/19) (subscription strategy — still open), [#20](https://github.com/freenet/raven/issues/20) (migration system)

## Context

Raven's prototype keeps all state in monolithic global contracts: one `posts`
contract holds every post in a shared feed (keyed by the build-injected
`__MODEL_CONTRACT__`), one global `follows` graph, one global `likes` contract.
The tracking issue [#8](https://github.com/freenet/raven/issues/8) moves Raven to
a full Twitter/X-like model — discoverable users, profiles, threaded
conversations, working follows. That requires deciding how state is partitioned
across contracts before the schema-changing workstreams (#11 profiles, #12
threads, #13 per-user feeds) land.

A Freenet contract is the unit of **replication, subscription, churn, merge, and
migration simultaneously**. A single contract has one subscription target, one
merge function, one state object that re-syncs to all subscribers on every
update, and one schema to version. How we draw contract boundaries therefore
determines subscription cost, abuse blast radius, merge complexity, and how
independently the pieces can evolve.

A natural objection: a contract's `update_state` is arbitrary WASM, so a *single*
per-user contract could enforce field-level write authority ("profile/posts
deltas require the owner's signature; notification appends accept any valid
signature"). This is true. **Authority enforcement is not the reason to split.**
The reason is that bundling surfaces with different write-patterns into one
contract couples their replication, subscription, churn, and migration even
though their producers and consumers differ.

## Decision

Partition contracts along the axis **(write-authority × churn × audience)**.
Surfaces that share all three live in one contract; a surface gets its own
contract wherever the write set opens up to the public, because that is where
churn and abuse-surface diverge.

This yields **three contract types**:

| Type | Cardinality | Write authority | Holds | Read by | Example key |
|------|-------------|-----------------|-------|---------|-------------|
| **User shard** | one per user | owner-writes only (signed by the key the contract is derived from) | profile, recent posts, follow list | followers / profile viewers | `hash(pubkey, "user")` |
| **Thread shard** | one per root post, created lazily on first reply | anyone-writes, append-only, gated by a valid writer credential (see [Abuse model](#abuse-model-public-write-surfaces)) | replies, likes, quote references targeting that post | anyone viewing the post | `hash(root_post_id, "thread")` |
| **Inbox shard** | one per user | anyone-writes gated by a valid writer credential; owner prunes | reply / mention / follow / quote notifications; (under fanout-on-write) delivered post copies | the owner | `hash(pubkey, "inbox")` |

The user shard deliberately bundles profile + posts + follows into one contract,
because all three are owner-writes / low-churn / read-by-followers — they share
the partitioning axis, so there is no benefit to splitting them. We split off the
thread and inbox shards only because their write set is public.

**Likes live only on the thread shard, not the user shard.** A like is
"anyone-writes, signed, targets a post" — the same shape that justifies storing
replies and quote refs on the thread shard. Recording likes-given on the user
shard as well would be double-bookkeeping (consistency risk if one write lands
and the other does not) and would drag a high-frequency surface onto the
otherwise near-static user shard. The "what has X liked?" view, if wanted, is a
delegate-local materialized view (the same pattern used for the timeline) or an
external discovery query over public thread-shard data — not replicated user
state.

Key derivation strings above are illustrative; the concrete primitive is
specified when #11 lands.

### Abuse model (public-write surfaces)

Thread and inbox shards accept writes from parties other than the contract
owner. A bare signature authenticates *a* writer but does not constrain *who*
can be a writer: with cheap keypair generation, "valid signature" is a
placeholder, not a policy, and both surfaces are open to Sybil flooding.
Per-writer rate limits in `update_state` only bite if writers are scarce.

The candidate defense is [GhostKey](https://freenet.org/ghostkey/):
donation-backed, blind-signed credentials — anonymous at issuance, pseudonymous
at use, and verifiable inside `update_state`. A write carries a GhostKey
certificate; with no valid cert, the write is rejected. Because each credential
cost real money to mint, per-writer rate limits become meaningful, and the
donation tier gives a later knob for graduated write caps without committing to
specifics now.

This ADR does not fix the final mechanism, but it names the abuse model and its
candidate defense rather than hiding the most important open question behind
"valid signature." The answer must be consistent across thread and inbox shards.

### Supporting decisions

- **Bounded state, enforced post-merge.** The user shard and inbox shard both
  accumulate and require a recent-N window (mirroring how `freenet/mail` windows
  its inbox contracts). Starting policy: the user shard retains roughly the last
  ~200 posts. Enforcement is a **post-merge truncation rule, not a pre-write
  check** — concurrent appends from different replicas can otherwise blow the
  bound at merge time; the merge function must deterministically keep the
  newest-N after combining states.
- **Durable history is not Raven's job.** The ~200-post window is the steady
  state, not a placeholder awaiting "archive shards." Long-term history, search,
  and discovery belong to an external indexing layer
  ([Atlas](https://github.com/freenet/atlas/blob/main/PROPOSAL.md)-style) that
  consumes Raven's public contracts. This implies a constraint on #11/#12: post
  objects should be **self-contained signed records with stable,
  externally-referenceable IDs**, so any downstream consumer (archiver,
  aggregator, indexer) can reference them without scraping and rehydrating
  internal embedded objects. The (owner-writes producer) → (external indexer)
  pattern will recur across Raven and Atlas; paying this cost at #11/#12 time is
  far cheaper than retrofitting it.
- **Delegate role.** A delegate may hold a durable **outbox with prune-on-ack**
  (the `PENDING_SENT_ACK` send-path pattern from `freenet/mail`) and a local
  materialized timeline. Delegate state is **private and local — not
  replicated** — so it cannot be where followers read content and does **not**
  reduce the readable-retention requirement on contracts. It does make the write
  path robust and enables fanout-on-write cleanly.

## Consequences

### Positive

- A follower subscribes to exactly the slice they want (a user's posts) without
  being woken by that user's incoming notifications.
- Slow-changing data (profile) no longer rides the same high-frequency update
  stream as fast-changing surfaces (incoming replies and likes, which live on
  thread shards).
- The public-write surfaces (thread, inbox) can be rate-limited and pruned
  independently, so spam there never bloats the state object that holds a user's
  identity.
- Each contract type versions and migrates on its own schedule (#20).
- Subscription count scales with follow count, not follow-count × surfaces:
  following N users means N user-shard subscriptions, not N per-surface
  subscriptions.

### Negative / costs

- Three contract types means three schema-tolerance surfaces and three
  append-only legacy-hash lists to maintain under the migration system (#20).
- Cross-contract operations need a delivery path. A quote post is authored on
  the quoter's user shard; the quoted author learns of it via a **notification
  to their inbox shard** — exactly what the inbox type is for ("anyone-writes
  notification to a user"). An earlier draft proposed skipping the
  back-reference; that is a UX regression versus Twitter and is unnecessary given
  the inbox mechanism already exists. (The quote reference may also be appended
  to the quoted post's thread shard so it surfaces to thread viewers.)
- Both accumulating contract types (user shard, inbox) need windowing logic; the
  unbounded-growth problem is relocated, not eliminated.

### Resolved by this ADR

- **#16** — per-user owner-writes shard, **not** a single global feed.
- **#18** — threads are stored in a **separate thread contract per root**,
  created lazily on the **first reply** (not on a bare like — spinning up a whole
  contract for a single like on an otherwise-uninteracted post is too much
  contract for too little state; such likes can wait in the liker's
  delegate-local view until the thread shard exists, or surface via external
  aggregation). Reply edges are not inlined into a global posts contract.

### Left open

- **#19** — fanout-on-read vs. fanout-on-write for assembling the "following"
  timeline. The inbox-shard type plus the delegate outbox make fanout-on-write
  viable (retention then lives in followers' inbox contracts, which need the same
  windowing); fanout-on-read keeps retention in the author's shard. The lever is
  identified but the choice is not made here. Open questions remain about
  celebrity-account fanout cost and whether the network handles a high
  subscription count gracefully.

## Alternatives considered

1. **Single global feed (status quo).** All posts in one contract. Rejected: one
   write hotspot, no per-user ownership, every subscriber re-syncs all posts, no
   natural moderation boundary.
2. **One contract per user with field-level write authority.** Technically valid
   (`update_state` is arbitrary WASM). Rejected as the *primary* structure
   because it couples replication/subscription/churn/merge/migration across
   surfaces with different audiences — a follower wanting posts would subscribe to
   the same firehose that carries the owner's incoming notifications, and the
   merge function would mix a single-writer register (profile) with a
   multi-writer grow-set (likes) at the coarsest common granularity.
3. **Four+ contracts per user** (separate profile / posts / follows / likes).
   Rejected: profile + posts + follows share the (owner-writes × low-churn ×
   read-by-followers) profile, so splitting them only multiplies subscription
   count with no benefit.
