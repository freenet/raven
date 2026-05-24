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

## Caveat: ADR vs. mail on windowing

The ADR states the bounded-state window mirrors "how `freenet/mail` windows its
inbox contracts." On inspection, the mail **inbox contract does no
contract-level truncation** — it bounds nothing in `update_state`; mail enforces
message age sender-side in the anti-flood-token delegate, because there is no
clock inside the contract WASM. So Raven's post-merge truncation is **new code**,
not a port, and it must be **count-based with a deterministic ordering** (by post
id) rather than time-based — a contract cannot read a wall clock. This is the
only material place the implementation diverges from the ADR's stated rationale.
