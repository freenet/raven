//! Inbox shard contract (ADR-0001, Phase 3).
//!
//! One contract **per user**, parameterized by the owner's ML-DSA-65 verifying
//! key bytes (`parameters = owner_vk_bytes`, exactly like the user shard), so the
//! contract key is `blake3(inbox_shard_wasm || owner_vk)` — distinct per user and
//! distinct from that user's user shard because the WASM hash differs (ADR-0001 →
//! "Shard key derivation").
//!
//! ## Write authority — anyone-writes notifications, owner-prunes
//!
//! The inbox is **anyone-writes** for *delivery*: any party may append a
//! [`Notification`] (a reply / mention / follow / quote targeting the owner).
//! Each notification **self-verifies** — it is signed by its *sender* and bound
//! to the owner's VK (the recipient), so it cannot be replayed into another
//! user's inbox. Who may be a sender is the abuse question ADR-0001 leaves to a
//! credential mechanism (GhostKey is the candidate); the [`WriterCert`] wire slot
//! is reserved and checked by [`verify_writer_cert`], which accepts everything
//! today.
//!
//! Only the **owner** may *prune*. A prune is an owner-signed
//! [`SignedOp`](freenet_microblogging_common::signed_op::SignedOp) bound to
//! [`INBOX_SHARD_CONTEXT`], in two forms:
//! * `OpType::PruneIds` — drop the explicit notification ids in the payload
//!   (selective: kill one spam notification).
//! * `OpType::PruneBefore` — advance a monotonic high-water `pruned_before` to
//!   `op.seq`, dropping every notification whose own `seq` is below it (bulk:
//!   "clear everything older than N").
//!
//! ## Convergence (every rule order-independent — AGENTS.md → "Contract
//! correctness invariants")
//!
//! The hard part of an owner-prune on an anyone-writes surface is that a *stale
//! replica* still holding a pruned notification must not **resurrect** it when it
//! merges with a pruned replica. So a prune leaves durable, convergent evidence:
//!
//! * **`pruned_before`** — a single monotonic high-water, merged **max-wins**. A
//!   notification with `seq < pruned_before` is dropped on *every* path and never
//!   re-admitted.
//! * **`tombstones`** — a grow-set `id -> owner_seq` for selectively-pruned ids.
//!   A tombstoned id is dropped on every path. Merged by max owner-seq per id.
//! * **`notifs`** — a grow-set keyed by content-addressed id, admitted only if
//!   the notification self-verifies, is **not** tombstoned, and is **not** below
//!   the high-water.
//!
//! `tombstones` is kept minimal: a tombstone whose notification `seq` is already
//! below `pruned_before` is **redundant** (the high-water alone suppresses it) and
//! is garbage-collected post-merge. So selective tombstones only persist while
//! newer than the bulk high-water, and the set cannot grow unbounded.
//!
//! Every prune op is re-verified against the owner on *every* path (delta,
//! full-state merge, sync delta); `validate_state` re-proves every stored
//! notification and rejects any that should have been pruned — the same "every
//! write path verifies, the two halves agree" discipline as the thread shard
//! (AGENTS.md → "Every write path verifies").

use freenet_microblogging_common::inbox::{Notification, WriterCert};
use freenet_microblogging_common::signed_op::{INBOX_SHARD_CONTEXT, OpType, SignedOp};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Cap on distinct retained notifications. Public-write (delivery), so this
/// bounds flood blast radius alongside the (future) writer-credential gate and
/// the owner's own pruning.
const MAX_NOTIFS: usize = 10_000;

/// Cap on retained tombstones. Tombstones are GC'd against the high-water, so
/// this only bites if an owner selectively prunes a huge number of ids that are
/// all newer than their bulk high-water; the cap keeps even that bounded.
const MAX_TOMBSTONES: usize = 10_000;

/// Max explicit ids one `PruneIds` op may carry, so a single signed op cannot
/// be made arbitrarily large.
const MAX_PRUNE_IDS_PER_OP: usize = 1_000;

/// Max length of a notification id (hex of a 32-byte blake3 hash = 64 chars);
/// a small margin guards against a malformed oversized key.
const MAX_ID_LEN: usize = 128;

/// Inbox shard state for one owner.
///
/// `notifs` stores the **full signed `Notification`**, not a stripped view: the
/// inbox is public-write, so the contract must assume adversarial `UpdateData`
/// and re-verify a notification on *every* path it can enter state. Retaining
/// the signature is what lets `validate_state` re-prove a notification and makes
/// a forged one (any peer, no key) impossible (the thread-shard CRITICAL lesson,
/// AGENTS.md → "Every write path verifies").
#[derive(Serialize, Deserialize, Default)]
struct InboxShard {
    // Schema-tolerance: defaults so older/newer wire shapes still decode
    // (AGENTS.md → "Contract migration").
    /// Notifications keyed by their content-addressed id.
    #[serde(default)]
    notifs: BTreeMap<String, Notification>,
    /// Selectively-pruned notification ids → the owner `seq` of the prune op
    /// that removed them (merged max-wins). A grow-set, GC'd against the
    /// high-water so it stays minimal.
    #[serde(default)]
    tombstones: BTreeMap<String, u64>,
    /// Monotonic high-water: every notification with `seq < pruned_before` is
    /// dropped. Merged max-wins.
    #[serde(default)]
    pruned_before: u64,
}

impl<'a> TryFrom<State<'a>> for InboxShard {
    type Error = ContractError;

    fn try_from(value: State<'a>) -> Result<Self, Self::Error> {
        serde_json::from_slice(value.as_ref()).map_err(|_| ContractError::InvalidState)
    }
}

/// A single inbox-shard delta operation. Externally tagged so the wire form is
/// unambiguous and new surfaces can be added without colliding.
#[derive(Serialize, Deserialize)]
enum InboxDelta {
    /// One or more incoming notifications (each self-signed by its sender).
    Notifs(Vec<Notification>),
    /// One owner-signed prune op (`PruneIds` or `PruneBefore`).
    Prune(SignedOp),
}

/// The inbox owner's VK as hex — the contract parameters interpreted as raw
/// encoded ML-DSA-65 VK bytes. This is both the recipient a notification must be
/// bound to and the only key whose prune ops are honored. Empty parameters yield
/// an empty owner hex that no real notification (bound to a 3904-hex VK) can
/// match and that no real signature can satisfy, so an un-parameterized inbox
/// accepts nothing.
fn owner_vk_hex(parameters: &Parameters<'_>) -> String {
    hex::encode(parameters.as_ref())
}

/// The writer-credential seam (ADR-0001 abuse model). Today it accepts every
/// sender — `WriterCert` is a reserved wire slot, not yet a policy. When a real
/// credential (GhostKey) lands, gate deliveries here; the cert already rides on
/// each notification so doing so is an additive change, not a format break.
fn verify_writer_cert(_cert: Option<&WriterCert>) -> bool {
    true
}

/// Whether a notification is, on its own merits, a well-formed delivery for this
/// inbox: bound to the owner, self-verifying, keyed under its own content
/// address, and carrying an acceptable writer credential. Does **not** consider
/// prune state — that is layered on by [`notif_admissible`].
fn notif_is_acceptable(id: &str, notif: &Notification, owner: &str) -> bool {
    !owner.is_empty()
        && id.len() <= MAX_ID_LEN
        && id == &notif.id(owner)
        && notif.verify(owner).is_ok()
        && verify_writer_cert(notif.writer_cert.as_ref())
}

/// Whether a notification may currently live in the inbox: acceptable on its own
/// merits **and** not suppressed by a prune (tombstoned, or below the
/// high-water). This is the single admission predicate every write path and
/// `validate_state` agree on.
fn notif_admissible(
    id: &str,
    notif: &Notification,
    owner: &str,
    tombstones: &BTreeMap<String, u64>,
    pruned_before: u64,
) -> bool {
    notif_is_acceptable(id, notif, owner)
        && !tombstones.contains_key(id)
        && notif.seq >= pruned_before
}

/// Admit one notification if currently admissible. Every path into `notifs` goes
/// through here, so a notification that does not verify for this owner — or that
/// the owner has pruned — is never stored, no matter which peer sent it.
fn merge_notif(shard: &mut InboxShard, notif: Notification, owner: &str) {
    let id = notif.id(owner);
    if notif_admissible(&id, &notif, owner, &shard.tombstones, shard.pruned_before) {
        // Content address is stable, so re-inserting the same notification is
        // idempotent (grow-set dedup).
        shard.notifs.entry(id).or_insert(notif);
    }
}

/// Apply a verified owner prune op to the shard, recording durable, convergent
/// evidence and dropping the now-suppressed notifications. Caller must have
/// already verified `op` against the owner.
fn apply_prune(shard: &mut InboxShard, op: &SignedOp) {
    match op.op_type {
        OpType::PruneIds => {
            // payload is a length-prefixed list of hex notif ids.
            for id in decode_prune_ids(&op.payload) {
                if id.len() > MAX_ID_LEN {
                    continue;
                }
                // Tombstone (max owner-seq wins) and drop the live notif.
                let cur = shard.tombstones.entry(id.clone()).or_insert(0);
                *cur = (*cur).max(op.seq);
                shard.notifs.remove(&id);
            }
        }
        OpType::PruneBefore => {
            // Advance the high-water monotonically (max-wins) and drop everything
            // below it.
            shard.pruned_before = shard.pruned_before.max(op.seq);
            shard.notifs.retain(|_, n| n.seq >= shard.pruned_before);
        }
        // A non-prune op type is not a valid inbox mutation; ignore it.
        OpType::Profile | OpType::Follow | OpType::Unfollow => {}
    }
}

/// Decode a `PruneIds` payload: a length-prefixed (u32 LE) concatenation of hex
/// id strings, capped at [`MAX_PRUNE_IDS_PER_OP`]. Malformed input yields the ids
/// parsed so far (tolerant, never panics — AGENTS.md → "No unwrap/panic").
fn decode_prune_ids(payload: &[u8]) -> Vec<String> {
    let mut ids = Vec::new();
    let mut i = 0;
    while i + 4 <= payload.len() && ids.len() < MAX_PRUNE_IDS_PER_OP {
        let len = u32::from_le_bytes([payload[i], payload[i + 1], payload[i + 2], payload[i + 3]])
            as usize;
        i += 4;
        if i + len > payload.len() {
            break;
        }
        if let Ok(s) = std::str::from_utf8(&payload[i..i + len]) {
            ids.push(s.to_owned());
        }
        i += len;
    }
    ids
}

/// Encode a `PruneIds` payload from a list of ids (mirror of [`decode_prune_ids`]).
/// Lives in the contract so tests and any future delegate share one encoder.
pub fn encode_prune_ids(ids: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();
    for id in ids {
        buf.extend_from_slice(&(id.len() as u32).to_le_bytes());
        buf.extend_from_slice(id.as_bytes());
    }
    buf
}

/// GC redundant tombstones: a tombstone whose id is below the high-water is
/// already suppressed by `pruned_before`, so it carries no extra information.
/// We cannot know a tombstoned id's original `seq` (the notif is gone), so we
/// instead bound the set by [`MAX_TOMBSTONES`] using a deterministic total order
/// over the key — keeping the largest keys is arbitrary but order-independent and
/// identical on every replica. (The high-water is the real bound on growth; this
/// is the backstop.)
fn truncate_tombstones(tombstones: &mut BTreeMap<String, u64>) {
    if tombstones.len() <= MAX_TOMBSTONES {
        return;
    }
    let mut keys: Vec<String> = tombstones.keys().cloned().collect();
    keys.sort();
    for key in keys.into_iter().skip(MAX_TOMBSTONES) {
        tombstones.remove(&key);
    }
}

/// Truncate notifications to the newest `MAX_NOTIFS` by `(seq, id)` desc — a
/// total order, so every replica retains the identical set regardless of arrival
/// order. Post-merge only. Best-effort lossy, like the user-shard post window.
fn truncate_notifs(notifs: &mut BTreeMap<String, Notification>) {
    if notifs.len() <= MAX_NOTIFS {
        return;
    }
    let mut order: Vec<(u64, String)> = notifs.iter().map(|(id, n)| (n.seq, id.clone())).collect();
    // Newest first: seq desc, then id desc as a stable total tie-break.
    order.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    for (_, id) in order.into_iter().skip(MAX_NOTIFS) {
        notifs.remove(&id);
    }
}

/// Normalize a merged state: drop any notification a prune now suppresses, then
/// enforce all caps post-merge. Pure function of the accumulated sets, so it is
/// order-independent. Run after every merge so a notification that arrived before
/// the prune that suppresses it is still removed (the prune may merge in second).
fn normalize(shard: &mut InboxShard) {
    let pruned_before = shard.pruned_before;
    // Re-apply prune suppression: a notif is only retained if not tombstoned and
    // not below the high-water. (Acceptance was already checked at insert; this
    // catches the case where the prune merged in *after* the notif.)
    let tombstones = std::mem::take(&mut shard.tombstones);
    shard
        .notifs
        .retain(|id, n| !tombstones.contains_key(id) && n.seq >= pruned_before);
    shard.tombstones = tombstones;
    // GC tombstones already covered by the high-water is not possible without the
    // original seq; bound the set instead.
    truncate_tombstones(&mut shard.tombstones);
    truncate_notifs(&mut shard.notifs);
}

/// Apply one decoded `InboxDelta` to the shard, verifying as it goes. Unverified
/// notifications and prune ops not signed by the owner are skipped (not fatal),
/// the same tolerance the other shards use for a bad entry in a batch.
fn apply_inbox_delta(shard: &mut InboxShard, delta: InboxDelta, owner: &str) {
    match delta {
        InboxDelta::Notifs(notifs) => {
            for notif in notifs {
                merge_notif(shard, notif, owner);
            }
        }
        InboxDelta::Prune(op) => {
            if owner.is_empty() || op.verify(INBOX_SHARD_CONTEXT, owner).is_err() {
                return;
            }
            apply_prune(shard, &op);
        }
    }
}

/// Try the tagged `InboxDelta` form first, then an `InboxStateDelta` (what
/// `get_state_delta` ships — notifs + prune evidence in one message), then a bare
/// `Vec<Notification>` (notifs-only backward tolerance), then a full `InboxShard`
/// (state-as-delta).
///
/// Order matters: `InboxStateDelta`'s fields are all `#[serde(default)]`, so it
/// would also accept a bare `{}`; `InboxDelta` (externally tagged, no defaults)
/// is tried first so a real tagged delta is never mis-decoded.
fn apply_delta_bytes(
    shard: &mut InboxShard,
    bytes: &[u8],
    owner: &str,
) -> Result<(), ContractError> {
    if let Ok(delta) = serde_json::from_slice::<InboxDelta>(bytes) {
        apply_inbox_delta(shard, delta, owner);
        return Ok(());
    }
    if let Ok(sd) = serde_json::from_slice::<InboxStateDelta>(bytes) {
        apply_state_delta(shard, sd, owner);
        return Ok(());
    }
    if let Ok(notifs) = serde_json::from_slice::<Vec<Notification>>(bytes) {
        apply_inbox_delta(shard, InboxDelta::Notifs(notifs), owner);
        return Ok(());
    }
    let other =
        serde_json::from_slice::<InboxShard>(bytes).map_err(|_| ContractError::InvalidDelta)?;
    merge_state(shard, other, owner);
    Ok(())
}

/// Apply an `InboxStateDelta` (the sync delta from `get_state_delta`). It carries
/// the prune evidence (`tombstones`, `pruned_before`) and the full self-verifying
/// notifications the requester lacks. Prune evidence is **owner-authored** and
/// merged first (so a notification the requester is about to receive is correctly
/// suppressed); notifications are re-verified by `merge_notif`.
///
/// Note the prune evidence here is not individually re-signed — it is the
/// *result* of owner prune ops the source already verified. Trusting a peer's
/// claimed `pruned_before` / `tombstones` can only ever *remove* notifications,
/// never add or forge one, so the worst a lying peer can do over sync is hide
/// notifications from a replica that syncs *from* it — never inject a forged
/// notification (those are re-verified) and never affect a replica that does not
/// sync from it. Removal-only is monotone and convergent, so this is safe; a
/// forged *addition* would not be.
fn apply_state_delta(shard: &mut InboxShard, sd: InboxStateDelta, owner: &str) {
    merge_prune_evidence(shard, sd.pruned_before, &sd.tombstones);
    for notif in sd.notifs {
        merge_notif(shard, notif, owner);
    }
}

/// Merge owner-authored prune evidence: high-water max-wins, tombstones unioned
/// (max owner-seq per id). Shared by state-delta and full-state merges.
fn merge_prune_evidence(
    shard: &mut InboxShard,
    pruned_before: u64,
    tombstones: &BTreeMap<String, u64>,
) {
    shard.pruned_before = shard.pruned_before.max(pruned_before);
    for (id, seq) in tombstones {
        if id.len() > MAX_ID_LEN {
            continue;
        }
        let cur = shard.tombstones.entry(id.clone()).or_insert(0);
        *cur = (*cur).max(*seq);
    }
}

/// Full-state merge: fold `other` into `shard` under the same acceptance +
/// convergence rules as a delta. Prune evidence merges first; then every
/// notification of `other` is re-verified — `other` came over the wire from a
/// possibly-adversarial peer, so "it was already validated upstream" is not an
/// assumption the contract may make (the thread-shard CRITICAL / M-1 lesson).
fn merge_state(shard: &mut InboxShard, other: InboxShard, owner: &str) {
    merge_prune_evidence(shard, other.pruned_before, &other.tombstones);
    for (_id, notif) in other.notifs {
        merge_notif(shard, notif, owner);
    }
}

#[contract]
impl ContractInterface for InboxShard {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts,
    ) -> Result<ValidateResult, ContractError> {
        let shard = InboxShard::try_from(state)?;
        let owner = owner_vk_hex(&parameters);

        // Every stored notification must be admissible: self-verifying, bound to
        // this owner, keyed under its own content address, AND not suppressed by
        // the prune state it is stored alongside. update_state guarantees all of
        // these, so validate_state must reject any state violating them (AGENTS.md
        // → "validate agrees with update"). In particular a notification that is
        // tombstoned or below the high-water would have been dropped by
        // update_state, so its presence here is invalid (a forged resurrection).
        for (id, notif) in &shard.notifs {
            if !notif_admissible(id, notif, &owner, &shard.tombstones, shard.pruned_before) {
                return Err(ContractError::InvalidState);
            }
        }
        Ok(ValidateResult::Valid)
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        delta: Vec<UpdateData>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let mut shard = InboxShard::try_from(state)?;
        let owner = owner_vk_hex(&parameters);

        // Iterate EVERY update item (not just the first), dispatching per kind.
        for item in &delta {
            match item {
                UpdateData::Delta(d) => apply_delta_bytes(&mut shard, d.as_ref(), &owner)?,
                UpdateData::State(s) => {
                    let other = InboxShard::try_from(State::from(s.to_vec()))?;
                    merge_state(&mut shard, other, &owner);
                }
                UpdateData::StateAndDelta { state: s, delta: d } => {
                    let other = InboxShard::try_from(State::from(s.to_vec()))?;
                    merge_state(&mut shard, other, &owner);
                    apply_delta_bytes(&mut shard, d.as_ref(), &owner)?;
                }
                _ => {}
            }
        }

        normalize(&mut shard);
        let bytes = serde_json::to_vec(&shard).map_err(|e| ContractError::Other(format!("{e}")))?;
        Ok(UpdateModification::valid(State::from(bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let shard = InboxShard::try_from(state)?;
        // Summary = the notif id set + prune evidence, so get_state_delta can
        // compute what the requester is missing (notifs) and whether it is behind
        // on pruning (high-water / tombstones).
        let summary = InboxSummary {
            notifs: shard.notifs.keys().cloned().collect(),
            tombstones: shard.tombstones.keys().cloned().collect(),
            pruned_before: shard.pruned_before,
        };
        let bytes =
            serde_json::to_vec(&summary).map_err(|e| ContractError::Other(format!("{e}")))?;
        Ok(StateSummary::from(bytes))
    }

    fn get_state_delta(
        parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let shard = InboxShard::try_from(state)?;
        let _ = owner_vk_hex(&parameters);
        let have: InboxSummary = serde_json::from_slice(summary.as_ref()).unwrap_or_default();

        let have_notifs: std::collections::HashSet<&String> = have.notifs.iter().collect();

        // Notifications the requester lacks — full signed records, re-verified on
        // the receiving side (a sync delta is no more trusted than any other).
        let missing_notifs: Vec<Notification> = shard
            .notifs
            .iter()
            .filter(|(id, _)| !have_notifs.contains(id))
            .map(|(_, n)| n.clone())
            .collect();

        // Always ship our prune evidence so the requester suppresses the right
        // notifications even if it is ahead on some and behind on pruning. This is
        // removal-only and convergent (see apply_state_delta).
        let delta = InboxStateDelta {
            notifs: missing_notifs,
            tombstones: shard.tombstones.clone(),
            pruned_before: shard.pruned_before,
        };
        let bytes = serde_json::to_vec(&delta).map_err(|e| ContractError::Other(format!("{e}")))?;
        Ok(StateDelta::from(bytes))
    }
}

/// Summary shape: the notif id set the requester already holds plus its prune
/// position, so `get_state_delta` can ship only what is missing.
#[derive(Serialize, Deserialize, Default)]
struct InboxSummary {
    #[serde(default)]
    notifs: Vec<String>,
    #[serde(default)]
    tombstones: Vec<String>,
    #[serde(default)]
    pruned_before: u64,
}

/// The delta `get_state_delta` ships: full self-verifying notifications the
/// requester lacks, plus the owner-authored prune evidence (removal-only). It is
/// intentionally NOT an `InboxDelta` so it can convey notifs and prune state at
/// once; `apply_delta_bytes` decodes it via `apply_state_delta`, which re-verifies
/// each notification.
#[derive(Serialize, Deserialize, Default)]
struct InboxStateDelta {
    #[serde(default)]
    notifs: Vec<Notification>,
    #[serde(default)]
    tombstones: BTreeMap<String, u64>,
    #[serde(default)]
    pruned_before: u64,
}

#[cfg(test)]
mod test {
    use super::*;
    use freenet_microblogging_common::inbox::NotifKind;
    use ml_dsa::KeyGen;
    use ml_dsa::signature::{Keypair, Signer};
    use ml_dsa::{MlDsa65, Signature};

    /// Owner identity for the inbox under test (seed 1).
    fn owner_seed() -> [u8; 32] {
        [1u8; 32]
    }

    fn owner_vk() -> String {
        let sk = MlDsa65::from_seed(&owner_seed().into());
        hex::encode(sk.verifying_key().encode())
    }

    fn params() -> Parameters<'static> {
        let sk = MlDsa65::from_seed(&owner_seed().into());
        Parameters::from(sk.verifying_key().encode().to_vec())
    }

    /// A signed notification to this inbox's owner from sender `seed`.
    fn signed_notif(seed: [u8; 32], kind: NotifKind, ref_id: &str, seq: u64) -> Notification {
        let sk = MlDsa65::from_seed(&seed.into());
        let owner = owner_vk();
        let mut n = Notification {
            kind,
            sender_pubkey: hex::encode(sk.verifying_key().encode()),
            ref_id: ref_id.into(),
            seq,
            writer_cert: None,
            signature: None,
        };
        let sig: Signature<MlDsa65> = sk.sign(&n.signing_payload(&owner));
        n.signature = Some(hex::encode(sig.encode()));
        n
    }

    /// An owner-signed prune op for this inbox.
    fn prune_op(op_type: OpType, payload: Vec<u8>, seq: u64) -> SignedOp {
        let sk = MlDsa65::from_seed(&owner_seed().into());
        let mut op = SignedOp {
            op_type,
            payload,
            seq,
            signer_pubkey: owner_vk(),
            signature: None,
        };
        let sig: Signature<MlDsa65> = sk.sign(&op.signing_payload(INBOX_SHARD_CONTEXT));
        op.signature = Some(hex::encode(sig.encode()));
        op
    }

    fn state_of(shard: &InboxShard) -> State<'static> {
        State::from(serde_json::to_vec(shard).unwrap())
    }

    fn delta_item(d: &InboxDelta) -> UpdateData<'static> {
        UpdateData::Delta(StateDelta::from(serde_json::to_vec(d).unwrap()))
    }

    fn run_update(shard: InboxShard, items: Vec<UpdateData<'static>>) -> InboxShard {
        let res = InboxShard::update_state(params(), state_of(&shard), items).unwrap();
        serde_json::from_slice(res.unwrap_valid().as_ref()).unwrap()
    }

    #[test]
    fn notif_accepted_only_when_bound_to_this_owner() {
        let good = signed_notif([2u8; 32], NotifKind::Reply, "post_a", 1);
        // A notif signed for a different recipient must be rejected here. Build one
        // bound to a bogus recipient.
        let sk = MlDsa65::from_seed(&[2u8; 32].into());
        let mut wrong = Notification {
            kind: NotifKind::Reply,
            sender_pubkey: hex::encode(sk.verifying_key().encode()),
            ref_id: "post_a".into(),
            seq: 1,
            writer_cert: None,
            signature: None,
        };
        let sig: Signature<MlDsa65> = sk.sign(&wrong.signing_payload("a_different_owner"));
        wrong.signature = Some(hex::encode(sig.encode()));

        let out = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![good.clone(), wrong]))],
        );
        assert_eq!(out.notifs.len(), 1);
        assert!(out.notifs.contains_key(&good.id(&owner_vk())));
    }

    #[test]
    fn notifs_dedup_by_content_address() {
        let n = signed_notif([2u8; 32], NotifKind::Quote, "post_x", 3);
        let out = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![n.clone(), n.clone()]))],
        );
        assert_eq!(out.notifs.len(), 1);
    }

    #[test]
    fn tampered_notif_signature_rejected() {
        let mut bad = signed_notif([2u8; 32], NotifKind::Reply, "p", 1);
        bad.seq = 99; // breaks signature
        let out = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![bad]))],
        );
        assert!(out.notifs.is_empty());
    }

    #[test]
    fn owner_prune_ids_removes_and_tombstones() {
        let n = signed_notif([2u8; 32], NotifKind::Reply, "p", 5);
        let id = n.id(&owner_vk());
        let base = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![n]))],
        );
        assert_eq!(base.notifs.len(), 1);

        let op = prune_op(OpType::PruneIds, encode_prune_ids(&[id.clone()]), 1);
        let out = run_update(base, vec![delta_item(&InboxDelta::Prune(op))]);
        assert!(out.notifs.is_empty(), "pruned notif removed");
        assert!(out.tombstones.contains_key(&id), "tombstone recorded");
    }

    #[test]
    fn tombstone_blocks_resurrection() {
        // Owner prunes a notif by id; a stale replica then re-delivers the same
        // notif. The tombstone must keep it out (no resurrection).
        let n = signed_notif([2u8; 32], NotifKind::Reply, "p", 5);
        let id = n.id(&owner_vk());
        let op = prune_op(OpType::PruneIds, encode_prune_ids(&[id.clone()]), 1);

        // Prune first, then the (late) re-delivery arrives.
        let pruned = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Prune(op))],
        );
        let out = run_update(pruned, vec![delta_item(&InboxDelta::Notifs(vec![n]))]);
        assert!(out.notifs.is_empty(), "tombstoned notif must not resurrect");
    }

    #[test]
    fn prune_before_drops_below_high_water_and_blocks_old() {
        let old = signed_notif([2u8; 32], NotifKind::Reply, "old", 3);
        let new = signed_notif([3u8; 32], NotifKind::Reply, "new", 10);
        let base = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![old, new.clone()]))],
        );
        assert_eq!(base.notifs.len(), 2);

        // Prune everything with seq < 5.
        let op = prune_op(OpType::PruneBefore, Vec::new(), 5);
        let out = run_update(base, vec![delta_item(&InboxDelta::Prune(op))]);
        assert_eq!(out.notifs.len(), 1, "old dropped, new kept");
        assert_eq!(out.pruned_before, 5);

        // A late old notif (seq 4) cannot be admitted below the high-water.
        let late = signed_notif([4u8; 32], NotifKind::Reply, "late", 4);
        let out2 = run_update(out, vec![delta_item(&InboxDelta::Notifs(vec![late]))]);
        assert_eq!(out2.notifs.len(), 1, "below-high-water notif rejected");
    }

    #[test]
    fn prune_before_is_monotonic() {
        let op_hi = prune_op(OpType::PruneBefore, Vec::new(), 10);
        let op_lo = prune_op(OpType::PruneBefore, Vec::new(), 3);
        // Apply high then low: the low must not lower the high-water.
        let out = run_update(
            InboxShard::default(),
            vec![
                delta_item(&InboxDelta::Prune(op_hi)),
                delta_item(&InboxDelta::Prune(op_lo)),
            ],
        );
        assert_eq!(out.pruned_before, 10);
    }

    #[test]
    fn non_owner_prune_rejected() {
        // A prune op signed by someone other than the owner must be ignored — the
        // signer != owner check in SignedOp::verify (owner-writes for prunes).
        let n = signed_notif([2u8; 32], NotifKind::Reply, "p", 5);
        let id = n.id(&owner_vk());
        let base = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![n]))],
        );

        // Forge a prune signed by a NON-owner key (seed 2) but claiming to prune.
        let attacker = MlDsa65::from_seed(&[2u8; 32].into());
        let mut op = SignedOp {
            op_type: OpType::PruneIds,
            payload: encode_prune_ids(&[id.clone()]),
            seq: 1,
            signer_pubkey: hex::encode(attacker.verifying_key().encode()),
            signature: None,
        };
        let sig: Signature<MlDsa65> = attacker.sign(&op.signing_payload(INBOX_SHARD_CONTEXT));
        op.signature = Some(hex::encode(sig.encode()));

        let out = run_update(base, vec![delta_item(&InboxDelta::Prune(op))]);
        assert_eq!(out.notifs.len(), 1, "non-owner prune must be ignored");
        assert!(out.tombstones.is_empty());
    }

    #[test]
    fn prune_op_replayed_from_user_shard_context_rejected() {
        // A prune op is bound to INBOX_SHARD_CONTEXT. An op the owner signed for
        // the USER_SHARD_CONTEXT (or any other context) must not verify here.
        use freenet_microblogging_common::signed_op::USER_SHARD_CONTEXT;
        let n = signed_notif([2u8; 32], NotifKind::Reply, "p", 5);
        let id = n.id(&owner_vk());
        let base = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![n]))],
        );

        let sk = MlDsa65::from_seed(&owner_seed().into());
        let mut op = SignedOp {
            op_type: OpType::PruneIds,
            payload: encode_prune_ids(&[id]),
            seq: 1,
            signer_pubkey: owner_vk(),
            signature: None,
        };
        // Signed for the WRONG context.
        let sig: Signature<MlDsa65> = sk.sign(&op.signing_payload(USER_SHARD_CONTEXT));
        op.signature = Some(hex::encode(sig.encode()));

        let out = run_update(base, vec![delta_item(&InboxDelta::Prune(op))]);
        assert_eq!(out.notifs.len(), 1, "cross-context prune must be ignored");
    }

    #[test]
    fn notif_arriving_before_prune_is_normalized_out() {
        // Prune evidence may merge in AFTER the notif (reordering). normalize must
        // drop a notif the high-water now suppresses even though it was admissible
        // when first inserted. Drive via two full-state merges.
        let old = signed_notif([2u8; 32], NotifKind::Reply, "old", 3);
        let with_notif = run_update(
            InboxShard::default(),
            vec![delta_item(&InboxDelta::Notifs(vec![old]))],
        );

        // A peer state that has only advanced the high-water (no notifs).
        let mut pruned_peer = InboxShard::default();
        pruned_peer.pruned_before = 5;

        let out = run_update(with_notif, vec![UpdateData::State(state_of(&pruned_peer))]);
        assert!(
            out.notifs.is_empty(),
            "notif below merged-in high-water normalized out"
        );
        assert_eq!(out.pruned_before, 5);
    }

    #[test]
    fn validate_rejects_misfiled_notif_id() {
        let mut shard = InboxShard::default();
        let n = signed_notif([2u8; 32], NotifKind::Reply, "x", 1);
        shard.notifs.insert("wrong_key".into(), n);
        let res = InboxShard::validate_state(params(), state_of(&shard), RelatedContracts::new());
        assert!(!matches!(res, Ok(ValidateResult::Valid)));
    }

    #[test]
    fn validate_rejects_forged_unsigned_notif() {
        // A state carrying an unsigned notif (no key) must fail validate — the two
        // halves agree, update_state would never store it (the thread CRITICAL
        // lesson applied to the inbox).
        let owner = owner_vk();
        let sk = MlDsa65::from_seed(&[2u8; 32].into());
        let forged = Notification {
            kind: NotifKind::Reply,
            sender_pubkey: hex::encode(sk.verifying_key().encode()),
            ref_id: "x".into(),
            seq: 1,
            writer_cert: None,
            signature: None, // forged: no signature
        };
        let id = forged.id(&owner);
        let mut shard = InboxShard::default();
        shard.notifs.insert(id, forged);
        let res = InboxShard::validate_state(params(), state_of(&shard), RelatedContracts::new());
        assert!(!matches!(res, Ok(ValidateResult::Valid)));
    }

    #[test]
    fn validate_rejects_tombstoned_notif_present() {
        // A notif that is also tombstoned in the same state would have been removed
        // by update_state, so its presence is invalid (a resurrection forgery).
        let n = signed_notif([2u8; 32], NotifKind::Reply, "p", 5);
        let id = n.id(&owner_vk());
        let mut shard = InboxShard::default();
        shard.notifs.insert(id.clone(), n);
        shard.tombstones.insert(id, 1);
        let res = InboxShard::validate_state(params(), state_of(&shard), RelatedContracts::new());
        assert!(!matches!(res, Ok(ValidateResult::Valid)));
    }

    #[test]
    fn validate_accepts_well_formed_state() {
        let n = signed_notif([2u8; 32], NotifKind::Follow, "", 1);
        let mut shard = InboxShard::default();
        shard.notifs.insert(n.id(&owner_vk()), n);
        let res = InboxShard::validate_state(params(), state_of(&shard), RelatedContracts::new())
            .unwrap();
        assert!(matches!(res, ValidateResult::Valid));
    }

    #[test]
    fn notifs_truncate_deterministically() {
        // Exercise the post-merge cap directly on `truncate_notifs` rather than
        // signing MAX_NOTIFS+ real notifications (ML-DSA signing 10k records is
        // minutes, not a CI fit). The cap is a pure function of the (seq, id) key
        // set and ignores signatures, so unsigned fixtures prove the same
        // order-independence property: both arrival orders retain the identical
        // newest-by-(seq,id) set.
        fn fake(id: &str, seq: u64) -> Notification {
            Notification {
                kind: NotifKind::Reply,
                sender_pubkey: "00".into(),
                ref_id: id.into(),
                seq,
                writer_cert: None,
                signature: None,
            }
        }
        let n = MAX_NOTIFS + 25;
        let mut a: BTreeMap<String, Notification> = BTreeMap::new();
        let mut b: BTreeMap<String, Notification> = BTreeMap::new();
        // Insert in opposite orders; the retained set must match.
        for i in 0..n {
            let id = format!("{i:08}");
            a.insert(id.clone(), fake(&id, 1000 + i as u64));
        }
        for i in (0..n).rev() {
            let id = format!("{i:08}");
            b.insert(id.clone(), fake(&id, 1000 + i as u64));
        }
        truncate_notifs(&mut a);
        truncate_notifs(&mut b);
        assert_eq!(a.len(), MAX_NOTIFS);
        assert_eq!(
            a.keys().collect::<Vec<_>>(),
            b.keys().collect::<Vec<_>>(),
            "cap must retain the same set regardless of insertion order"
        );
    }

    #[test]
    fn empty_owner_param_accepts_nothing() {
        let n = signed_notif([2u8; 32], NotifKind::Reply, "p", 1);
        let res = InboxShard::update_state(
            Parameters::from(Vec::new()),
            state_of(&InboxShard::default()),
            vec![delta_item(&InboxDelta::Notifs(vec![n]))],
        )
        .unwrap();
        let out: InboxShard = serde_json::from_slice(res.unwrap_valid().as_ref()).unwrap();
        assert!(out.notifs.is_empty());
    }

    #[test]
    fn get_state_delta_output_is_applyable() {
        // Regression: get_state_delta ships an InboxStateDelta; apply_delta_bytes
        // must decode and apply it (round-trip), or peers never sync.
        let mut src = InboxShard::default();
        let n = signed_notif([2u8; 32], NotifKind::Reply, "r", 5);
        src.notifs.insert(n.id(&owner_vk()), n);
        src.pruned_before = 2;
        src.tombstones.insert("some_pruned_id".into(), 1);

        let empty_summary =
            StateSummary::from(serde_json::to_vec(&InboxSummary::default()).unwrap());
        let delta = InboxShard::get_state_delta(params(), state_of(&src), empty_summary).unwrap();

        let out = run_update(
            InboxShard::default(),
            vec![UpdateData::Delta(StateDelta::from(
                delta.into_bytes().to_vec(),
            ))],
        );
        assert_eq!(out.notifs.len(), 1);
        assert_eq!(out.pruned_before, 2);
        assert!(out.tombstones.contains_key("some_pruned_id"));
    }

    #[test]
    fn forged_notif_via_full_state_merge_rejected() {
        // CRITICAL-class regression: an adversary crafts an InboxShard whose notifs
        // map carries an unsigned notif, shipped as UpdateData::State. merge_state
        // must re-verify and drop it.
        let owner = owner_vk();
        let sk = MlDsa65::from_seed(&[2u8; 32].into());
        let forged = Notification {
            kind: NotifKind::Reply,
            sender_pubkey: hex::encode(sk.verifying_key().encode()),
            ref_id: "x".into(),
            seq: 1,
            writer_cert: None,
            signature: None,
        };
        let mut malicious = InboxShard::default();
        malicious.notifs.insert(forged.id(&owner), forged);
        let out = run_update(
            InboxShard::default(),
            vec![UpdateData::State(state_of(&malicious))],
        );
        assert!(
            out.notifs.is_empty(),
            "forged unsigned notif must not be stored"
        );
    }

    #[test]
    fn decodes_old_shape_state() {
        let empty: InboxShard = serde_json::from_slice(b"{}").unwrap();
        assert!(empty.notifs.is_empty() && empty.tombstones.is_empty() && empty.pruned_before == 0);
        let forward: InboxShard = serde_json::from_slice(
            br#"{"notifs":{},"tombstones":{},"pruned_before":0,"version":2}"#,
        )
        .unwrap();
        assert!(forward.notifs.is_empty());
    }

    #[test]
    fn prune_ids_payload_round_trips() {
        let ids = vec!["aaa".to_string(), "bbb".to_string(), "ccc".to_string()];
        let encoded = encode_prune_ids(&ids);
        assert_eq!(decode_prune_ids(&encoded), ids);
        // Truncated/garbage trailing bytes are tolerated (no panic).
        let mut trunc = encoded.clone();
        trunc.truncate(encoded.len() - 1);
        let _ = decode_prune_ids(&trunc); // must not panic
    }
}

/// Integration tests: drive the full `ContractInterface` (validate / update /
/// summarize / get_state_delta) through multi-replica scenarios — the layer above
/// the per-function unit tests. The key scenarios are **two replicas reconciling
/// via the real sync protocol** and the **owner-prune convergence invariant** (a
/// pruned notification must not resurrect through a stale replica).
///
/// These still call the contract as a Rust library (not compiled WASM in a node);
/// true WASM-in-node e2e is a separate, heavier tier (see the `freenet:linux-test`
/// skill).
#[cfg(test)]
mod integration {
    use super::*;
    use freenet_microblogging_common::inbox::NotifKind;
    use ml_dsa::signature::{Keypair, Signer};
    use ml_dsa::{KeyGen, MlDsa65, Signature};

    fn owner_seed() -> [u8; 32] {
        [1u8; 32]
    }
    fn owner_vk() -> String {
        let sk = MlDsa65::from_seed(&owner_seed().into());
        hex::encode(sk.verifying_key().encode())
    }
    fn params() -> Parameters<'static> {
        let sk = MlDsa65::from_seed(&owner_seed().into());
        Parameters::from(sk.verifying_key().encode().to_vec())
    }
    fn state_of(shard: &InboxShard) -> State<'static> {
        State::from(serde_json::to_vec(shard).unwrap())
    }
    fn decode(state: State<'static>) -> InboxShard {
        serde_json::from_slice(state.as_ref()).unwrap()
    }

    fn notif(seed: [u8; 32], kind: NotifKind, ref_id: &str, seq: u64) -> Notification {
        let sk = MlDsa65::from_seed(&seed.into());
        let owner = owner_vk();
        let mut n = Notification {
            kind,
            sender_pubkey: hex::encode(sk.verifying_key().encode()),
            ref_id: ref_id.into(),
            seq,
            writer_cert: None,
            signature: None,
        };
        let sig: Signature<MlDsa65> = sk.sign(&n.signing_payload(&owner));
        n.signature = Some(hex::encode(sig.encode()));
        n
    }

    fn prune_op(op_type: OpType, payload: Vec<u8>, seq: u64) -> SignedOp {
        let sk = MlDsa65::from_seed(&owner_seed().into());
        let mut op = SignedOp {
            op_type,
            payload,
            seq,
            signer_pubkey: owner_vk(),
            signature: None,
        };
        let sig: Signature<MlDsa65> = sk.sign(&op.signing_payload(INBOX_SHARD_CONTEXT));
        op.signature = Some(hex::encode(sig.encode()));
        op
    }

    fn apply(shard: &InboxShard, items: Vec<UpdateData<'static>>) -> InboxShard {
        let res = InboxShard::update_state(params(), state_of(shard), items).unwrap();
        decode(res.unwrap_valid())
    }

    fn delta(d: &InboxDelta) -> UpdateData<'static> {
        UpdateData::Delta(StateDelta::from(serde_json::to_vec(d).unwrap()))
    }

    /// One directional sync step, faithful to the node protocol.
    fn sync_into(dst: &InboxShard, src: &InboxShard) -> InboxShard {
        assert!(matches!(
            InboxShard::validate_state(params(), state_of(dst), RelatedContracts::new()).unwrap(),
            ValidateResult::Valid
        ));
        let summary = InboxShard::summarize_state(params(), state_of(dst)).unwrap();
        let d = InboxShard::get_state_delta(params(), state_of(src), summary).unwrap();
        let merged = apply(
            dst,
            vec![UpdateData::Delta(StateDelta::from(d.into_bytes().to_vec()))],
        );
        assert!(matches!(
            InboxShard::validate_state(params(), state_of(&merged), RelatedContracts::new())
                .unwrap(),
            ValidateResult::Valid
        ));
        merged
    }

    fn reconcile(a: &InboxShard, b: &InboxShard) -> (InboxShard, InboxShard) {
        let a2 = sync_into(a, b);
        let b2 = sync_into(b, a);
        (a2, b2)
    }

    fn canonical(shard: &InboxShard) -> Vec<u8> {
        serde_json::to_vec(shard).unwrap()
    }

    #[test]
    fn two_replicas_converge_over_sync_protocol() {
        let empty = InboxShard::default();
        let a = apply(
            &empty,
            vec![delta(&InboxDelta::Notifs(vec![
                notif([2; 32], NotifKind::Reply, "ra", 1),
                notif([3; 32], NotifKind::Follow, "", 2),
            ]))],
        );
        let b = apply(
            &empty,
            vec![delta(&InboxDelta::Notifs(vec![notif(
                [4; 32],
                NotifKind::Quote,
                "qb",
                3,
            )]))],
        );

        let (a2, b2) = reconcile(&a, &b);
        assert_eq!(canonical(&a2), canonical(&b2), "replicas must converge");
        assert_eq!(a2.notifs.len(), 3);
    }

    #[test]
    fn pruned_notif_does_not_resurrect_through_stale_replica() {
        // THE inbox convergence invariant. Replica A delivers a notif, then the
        // owner prunes it on A. Replica B still holds the original (un-pruned)
        // notif. After reconcile, both must agree the notif is GONE — B's stale
        // copy must not resurrect it on A.
        let n = notif([2; 32], NotifKind::Reply, "p", 5);
        let id = n.id(&owner_vk());

        let a_delivered = apply(
            &InboxShard::default(),
            vec![delta(&InboxDelta::Notifs(vec![n.clone()]))],
        );
        // B is the stale replica: it has the notif and never saw the prune.
        let b_stale = apply(
            &InboxShard::default(),
            vec![delta(&InboxDelta::Notifs(vec![n]))],
        );
        // Owner prunes on A.
        let a_pruned = apply(
            &a_delivered,
            vec![delta(&InboxDelta::Prune(prune_op(
                OpType::PruneIds,
                encode_prune_ids(&[id.clone()]),
                1,
            )))],
        );
        assert!(a_pruned.notifs.is_empty());

        let (a2, b2) = reconcile(&a_pruned, &b_stale);
        assert_eq!(canonical(&a2), canonical(&b2), "replicas must converge");
        assert!(
            a2.notifs.is_empty() && b2.notifs.is_empty(),
            "pruned notif must stay pruned on both replicas (no resurrection)"
        );
        assert!(a2.tombstones.contains_key(&id));
    }

    #[test]
    fn high_water_prune_converges_over_sync() {
        // A advances the high-water past some notifs; B is behind. After sync both
        // hold the same high-water and the same (post-prune) notif set.
        let old = notif([2; 32], NotifKind::Reply, "old", 3);
        let new = notif([3; 32], NotifKind::Reply, "new", 10);
        let a = apply(
            &InboxShard::default(),
            vec![
                delta(&InboxDelta::Notifs(vec![old.clone(), new.clone()])),
                delta(&InboxDelta::Prune(prune_op(
                    OpType::PruneBefore,
                    Vec::new(),
                    5,
                ))),
            ],
        );
        // B still has the old notif and a zero high-water.
        let b = apply(
            &InboxShard::default(),
            vec![delta(&InboxDelta::Notifs(vec![old, new]))],
        );

        let (a2, b2) = reconcile(&a, &b);
        assert_eq!(canonical(&a2), canonical(&b2));
        assert_eq!(a2.pruned_before, 5);
        assert_eq!(
            a2.notifs.len(),
            1,
            "only the above-high-water notif survives"
        );
    }

    #[test]
    fn forged_notif_does_not_propagate_over_sync() {
        // A malicious replica holds a forged (unsigned) notif. An honest replica
        // syncing from it re-verifies and drops it.
        let owner = owner_vk();
        let sk = MlDsa65::from_seed(&[9u8; 32].into());
        let forged = Notification {
            kind: NotifKind::Reply,
            sender_pubkey: hex::encode(sk.verifying_key().encode()),
            ref_id: "x".into(),
            seq: 1,
            writer_cert: None,
            signature: None,
        };
        let mut malicious = InboxShard::default();
        malicious.notifs.insert(forged.id(&owner), forged);

        let honest = InboxShard::default();
        let synced = sync_into(&honest, &malicious);
        assert!(
            synced.notifs.is_empty(),
            "honest replica must reject forged notif over sync"
        );
    }

    #[test]
    fn cross_shard_recipient_binding_is_consistent() {
        // A notification's recipient binding is exactly the inbox shard's owner VK
        // (its parameters). A notif addressed to owner-1 must land on owner-1's
        // inbox and be rejected by owner-2's inbox — the cross-shard contract that
        // makes inboxes non-fungible.
        let owner1_vk = owner_vk(); // seed 1
        let owner2_sk = MlDsa65::from_seed(&[20u8; 32].into());
        let owner2_params = Parameters::from(owner2_sk.verifying_key().encode().to_vec());

        // A notif addressed to owner-1.
        let n = notif([2; 32], NotifKind::Reply, "p", 1);

        // Accepted on owner-1's inbox.
        let on_1 = apply(
            &InboxShard::default(),
            vec![delta(&InboxDelta::Notifs(vec![n.clone()]))],
        );
        assert_eq!(on_1.notifs.len(), 1);
        assert!(on_1.notifs.contains_key(&n.id(&owner1_vk)));

        // Rejected on owner-2's inbox (its signed recipient is owner-1, not 2).
        let res = InboxShard::update_state(
            owner2_params,
            State::from(serde_json::to_vec(&InboxShard::default()).unwrap()),
            vec![UpdateData::Delta(StateDelta::from(
                serde_json::to_vec(&InboxDelta::Notifs(vec![n])).unwrap(),
            ))],
        )
        .unwrap();
        let on_2: InboxShard = serde_json::from_slice(res.unwrap_valid().as_ref()).unwrap();
        assert!(
            on_2.notifs.is_empty(),
            "notif must not land on the wrong inbox"
        );
    }
}
