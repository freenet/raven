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
| **User shard** | one per user | owner-writes only (signed by the key the contract is derived from) | profile, recent posts, follow list, likes-given | followers / profile viewers | `hash(pubkey, "user")` |
| **Thread shard** | one per root post, created lazily on first interaction (reply OR like) | anyone-writes with a valid signature, append-only | replies, likes, quote references targeting that post | anyone viewing the post | `hash(root_post_id, "thread")` |
| **Inbox shard** | one per user | anyone-writes with a valid signature; owner prunes | reply/mention/follow notifications; (under fanout-on-write) delivered post copies | the owner | `hash(pubkey, "inbox")` |

The user shard deliberately bundles profile + posts + follows into one contract,
because all three are owner-writes / low-churn / read-by-followers — they share
the partitioning axis, so there is no benefit to splitting them. We split off the
thread and inbox shards only because their write set is public.

Key derivation strings above are illustrative; the concrete primitive is
specified when #11 lands.

### Supporting decisions

- **Bounded state.** User shard and inbox shard both accumulate and require a
  recent-N window (mirroring how `freenet/mail` windows its inbox contracts).
  Starting policy: the user shard retains roughly the last ~200 posts and older
  ones drop. Dated archive shards (`hash(pubkey, "YYYY-MM")`) for durable history
  are a possible later addition, not part of v1.
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
  stream as fast-changing data (incoming likes).
- The public-write surfaces (thread, inbox) can be rate-limited and pruned
  independently, so spam there never bloats the state object that holds a user's
  identity.
- Each contract type versions and migrates on its own schedule (#20).
- Subscription count scales with follow count, not follow-count × surfaces:
  following N users means N user-shard subscriptions, not N × 4.

### Negative / costs

- Three contract types means three schema-tolerance surfaces and three
  append-only legacy-hash lists to maintain under the migration system (#20).
- Cross-contract operations (e.g. a quote post authored in a user shard that
  also references a thread shard) require either a cross-write or accepting a
  missing back-reference. Decision: **skip the back-reference** — a quote shows
  up to readers who follow the author; the quoted thread does not need to learn
  it was quoted.
- Both accumulating contract types (user shard, inbox) need windowing logic; the
  unbounded-growth problem is relocated, not eliminated.

### Resolved by this ADR

- **#16** — per-user owner-writes shard, **not** a single global feed.
- **#18** — threads are stored in a **separate thread contract per root**,
  created lazily on first interaction; reply edges are not inlined into a global
  posts contract.

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
