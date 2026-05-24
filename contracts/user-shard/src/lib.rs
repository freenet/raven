//! User shard contract (ADR-0001, Phase 1).
//!
//! One contract per user, **owner-writes only**, parameterized by the owner's
//! raw encoded ML-DSA-65 verifying key. It bundles the three owner-writes /
//! low-churn / read-by-followers surfaces the ADR assigns to the user shard:
//!
//!   * **posts** — a windowed feed of the owner's recent posts;
//!   * **profile** — a single last-write-wins register (display name, handle,
//!     bio, avatar);
//!   * **follows** — the set of pubkeys the owner follows.
//!
//! ## Write authority
//!
//! Posts are self-signed and content-addressed, so a post proves owner-authorship
//! directly (`common::post::Post::verify` + `author_pubkey == owner`). Profile and
//! follow mutations are not posts, so they arrive as `common::signed_op::SignedOp`
//! envelopes: an ML-DSA-65 signature by the owner over a domain-tagged payload.
//! Both gates reduce to the same VK-param match — only the owner's key is accepted.
//!
//! ## Delta format
//!
//! Updates are a `ShardDelta` (an externally-tagged enum), so a single contract
//! can host more than one surface in one delta stream. `update_state` iterates
//! **every** `UpdateData` item (not just the first) and dispatches per variant.
//! Full-state (`UpdateData::State`) merges deserialize a whole `UserShard` and
//! fold each surface, so a peer syncing its latest state reconciles all three
//! surfaces — not only posts.
//!
//! ## Convergence
//!
//! * **posts** — grow-set deduped by content-address id, then truncated to the
//!   newest `MAX_POSTS` by `(timestamp, id)` desc (a total order; no clock in a
//!   contract). Order-independent.
//! * **profile** — last-write-wins by a monotonic `seq` (tie-break by serialized
//!   bytes for determinism). Order-independent.
//! * **follows** — each followed key records the `seq` of the op that last
//!   touched it and whether that op was Follow; merge keeps the higher seq per
//!   key. Convergent under reordering, unlike a bare add/remove set.

use freenet_microblogging_common::post::{MAX_CONTENT_LEN, Post};
use freenet_microblogging_common::signed_op::{OpType, Profile, SignedOp};
use freenet_stdlib::prelude::{
    blake3::{Hasher as Blake3, traits::digest::Digest},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Recent-post retention window. ADR-0001 starting policy: ~200.
const MAX_POSTS: usize = 200;

/// Per-key follow record: the `seq` of the op that last touched this key and
/// whether that op was a Follow (`true`) or an Unfollow (`false`). Merge keeps
/// the entry with the higher `seq`, so concurrent follow/unfollow of the same
/// key converges deterministically regardless of arrival order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct FollowState {
    seq: u64,
    following: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct UserShard {
    // Schema-tolerance: defaults so older/newer wire shapes still decode.
    // See AGENTS.md → "Contract migration".
    #[serde(default)]
    posts: Vec<Post>,
    /// Latest profile register, with the `seq` that set it (for LWW merge).
    /// `None` until the owner first sets a profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<ProfileRegister>,
    /// Followed pubkeys keyed by target VK hex (`BTreeMap` for deterministic
    /// serialization order).
    #[serde(default)]
    follows: BTreeMap<String, FollowState>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct ProfileRegister {
    profile: Profile,
    seq: u64,
}

impl<'a> TryFrom<State<'a>> for UserShard {
    type Error = ContractError;

    fn try_from(value: State<'a>) -> Result<Self, Self::Error> {
        serde_json::from_slice(value.as_ref()).map_err(|_| ContractError::InvalidState)
    }
}

/// A single delta operation. Externally tagged so the wire form is unambiguous
/// and new surfaces can be added without colliding with the post array.
#[derive(Serialize, Deserialize)]
enum ShardDelta {
    /// One or more of the owner's posts (each self-signed + content-addressed).
    Posts(Vec<Post>),
    /// An owner-signed profile / follow / unfollow op.
    Op(SignedOp),
}

/// The owner VK for this shard as hex, to compare against a post's
/// `author_pubkey` / a `SignedOp`'s `signer_pubkey`. Parameters are the raw
/// encoded ML-DSA-65 VK bytes; empty parameters yield an empty owner key that no
/// real signed record can match (an un-parameterized shard accepts nothing).
fn owner_vk_hex(parameters: &Parameters<'_>) -> String {
    hex::encode(parameters.as_ref())
}

/// Dedup/summary key for a post: blake3 over its content-addressed id.
fn post_hash(post: &Post) -> [u8; 32] {
    let mut hasher = Blake3::new();
    hasher.update(post.id.as_bytes());
    let hash_val = hasher.finalize();
    let mut key = [0; 32];
    key.copy_from_slice(&hash_val[..]);
    key
}

/// A post is acceptable iff within the length bound, self-verifying, and authored
/// by this shard's owner (owner-writes — ADR-0001).
fn post_is_acceptable(post: &Post, owner_vk_hex: &str) -> bool {
    post.content.len() <= MAX_CONTENT_LEN
        && post.author_pubkey == owner_vk_hex
        && post.verify().is_ok()
}

/// Deterministic "newest-first" ordering for the retention window: timestamp
/// desc, then content-addressed id desc as a stable, total tie-break.
fn newest_first(a: &Post, b: &Post) -> std::cmp::Ordering {
    b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id))
}

/// Keep only the newest `MAX_POSTS` after a merge, then restore canonical merge
/// order (sorted by `post_hash`). Deterministic across replicas.
fn truncate_window(posts: &mut Vec<Post>) {
    if posts.len() > MAX_POSTS {
        posts.sort_by(newest_first);
        posts.truncate(MAX_POSTS);
    }
    posts.sort_by_cached_key(post_hash);
}

/// Whether a slice of posts is a valid stored set: every post acceptable AND no
/// two posts share a content-address id. (Uniqueness is what `update_state`
/// guarantees via dedup; `validate_state` enforces the same invariant so the two
/// halves of the contract agree on what a valid state is.)
fn posts_are_valid_state(posts: &[Post], owner: &str) -> bool {
    let mut seen = std::collections::HashSet::with_capacity(posts.len());
    for post in posts {
        if !post_is_acceptable(post, owner) {
            return false;
        }
        if !seen.insert(post_hash(post)) {
            return false; // duplicate id
        }
    }
    true
}

/// Apply an owner-signed op to the shard. Returns whether anything changed.
/// Rejected (non-owner / bad signature / out-of-bounds) ops are silently
/// skipped — a bad op in a batch is dropped, not fatal.
fn apply_op(shard: &mut UserShard, op: &SignedOp, owner: &str) -> bool {
    if op.verify(owner).is_err() {
        return false;
    }
    match op.op_type {
        OpType::Profile => {
            let Ok(profile) = serde_json::from_slice::<Profile>(&op.payload) else {
                return false;
            };
            if !profile.within_bounds() {
                return false;
            }
            // Last-write-wins by seq; tie-break by serialized bytes so two
            // replicas applying different same-seq profiles still converge.
            let replace = match &shard.profile {
                None => true,
                Some(cur) => {
                    op.seq > cur.seq
                        || (op.seq == cur.seq
                            && serde_json::to_vec(&profile).unwrap_or_default()
                                > serde_json::to_vec(&cur.profile).unwrap_or_default())
                }
            };
            if replace {
                shard.profile = Some(ProfileRegister {
                    profile,
                    seq: op.seq,
                });
                return true;
            }
            false
        }
        OpType::Follow | OpType::Unfollow => {
            // Payload is a JSON array of target pubkey hex strings.
            let Ok(targets) = serde_json::from_slice::<Vec<String>>(&op.payload) else {
                return false;
            };
            let following = matches!(op.op_type, OpType::Follow);
            let mut changed = false;
            for target in targets {
                let entry = shard.follows.get(&target);
                // Higher seq wins per key; equal seq keeps existing (idempotent).
                let apply = match entry {
                    None => true,
                    Some(cur) => op.seq > cur.seq,
                };
                if apply {
                    shard.follows.insert(
                        target,
                        FollowState {
                            seq: op.seq,
                            following,
                        },
                    );
                    changed = true;
                }
            }
            changed
        }
    }
}

/// Merge another whole `UserShard` (from a full-state update) into `shard`,
/// honoring each surface's convergence rule.
fn merge_state(shard: &mut UserShard, other: UserShard, owner: &str) {
    for post in other.posts {
        if post_is_acceptable(&post, owner) {
            shard.posts.push(post);
        }
    }
    // Profile: LWW by seq, same rule as apply_op (bytes tie-break).
    if let Some(other_p) = other.profile {
        let replace = match &shard.profile {
            None => true,
            Some(cur) => {
                other_p.seq > cur.seq
                    || (other_p.seq == cur.seq
                        && serde_json::to_vec(&other_p.profile).unwrap_or_default()
                            > serde_json::to_vec(&cur.profile).unwrap_or_default())
            }
        };
        if replace {
            shard.profile = Some(other_p);
        }
    }
    // Follows: higher seq wins per key.
    for (target, other_fs) in other.follows {
        let keep = match shard.follows.get(&target) {
            None => true,
            Some(cur) => other_fs.seq > cur.seq,
        };
        if keep {
            shard.follows.insert(target, other_fs);
        }
    }
}

/// Restore canonical storage order + dedup posts after any merge.
fn normalize(shard: &mut UserShard) {
    shard.posts.sort_by_cached_key(post_hash);
    shard.posts.dedup_by_key(|p| post_hash(p));
    truncate_window(&mut shard.posts);
}

// ---------------------------------------------------------------------------
// Summary: one fixed-width entry per surface so every surface reconciles via
// the delta path. Post entries are per-post content hashes; profile + follows
// fold to a single hash each (their full reconciliation rides the state path,
// but the summary must still *differ* when they differ so a delta is requested).
// ---------------------------------------------------------------------------
#[derive(Serialize, Deserialize)]
struct ShardSummary {
    posts: Vec<MessageSummary>,
    /// blake3 over the serialized profile register (zeroed if none).
    profile: [u8; 32],
    /// blake3 over the serialized follows map.
    follows: [u8; 32],
}

fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Blake3::new();
    hasher.update(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(hasher.finalize().as_ref());
    out
}

impl ShardSummary {
    fn of(shard: &UserShard) -> Self {
        let posts = shard
            .posts
            .iter()
            .map(|p| MessageSummary(post_hash(p)))
            .collect();
        let profile = match &shard.profile {
            Some(p) => hash_bytes(&serde_json::to_vec(p).unwrap_or_default()),
            None => [0u8; 32],
        };
        let follows = hash_bytes(&serde_json::to_vec(&shard.follows).unwrap_or_default());
        ShardSummary {
            posts,
            profile,
            follows,
        }
    }
}

#[derive(Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct MessageSummary([u8; 32]);

#[contract]
impl ContractInterface for UserShard {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts,
    ) -> Result<ValidateResult, ContractError> {
        let owner = owner_vk_hex(&parameters);
        let shard = UserShard::try_from(state)?;
        // Posts: every post acceptable AND ids unique (the invariant update_state
        // guarantees). The retention *window* is deliberately NOT enforced here —
        // a transiently over-bound merged state is normal and rejecting it would
        // break convergence.
        if !posts_are_valid_state(&shard.posts, &owner) {
            return Ok(ValidateResult::Invalid);
        }
        // Profile: if present, must be within field bounds.
        if let Some(reg) = &shard.profile {
            if !reg.profile.within_bounds() {
                return Ok(ValidateResult::Invalid);
            }
        }
        Ok(ValidateResult::Valid)
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        delta: Vec<UpdateData>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        if delta.is_empty() {
            return Ok(UpdateModification::valid(state));
        }
        let owner = owner_vk_hex(&parameters);
        let mut shard = UserShard::try_from(state)?;

        // Process EVERY update item (not just the first).
        for item in &delta {
            match item {
                UpdateData::Delta(d) => apply_delta_bytes(&mut shard, d.as_ref(), &owner)?,
                UpdateData::State(s) => {
                    let other = UserShard::try_from(State::from(s.to_vec()))?;
                    merge_state(&mut shard, other, &owner);
                }
                UpdateData::StateAndDelta { state, delta } => {
                    let other = UserShard::try_from(State::from(state.to_vec()))?;
                    merge_state(&mut shard, other, &owner);
                    apply_delta_bytes(&mut shard, delta.as_ref(), &owner)?;
                }
                _ => {}
            }
        }

        normalize(&mut shard);
        let shard_bytes =
            serde_json::to_vec(&shard).map_err(|err| ContractError::Other(format!("{err}")))?;
        Ok(UpdateModification::valid(State::from(shard_bytes)))
    }

    fn summarize_state(
        parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let _ = parameters;
        let shard = UserShard::try_from(state)?;
        let summary = ShardSummary::of(&shard);
        Ok(StateSummary::from(
            serde_json::to_vec(&summary).map_err(|err| ContractError::Other(format!("{err}")))?,
        ))
    }

    fn get_state_delta(
        parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let _ = parameters;
        let shard = UserShard::try_from(state)?;
        let remote = serde_json::from_slice::<ShardSummary>(&summary).unwrap_or(ShardSummary {
            posts: vec![],
            profile: [0u8; 32],
            follows: [0u8; 32],
        });

        // Posts the remote lacks → emit as a Posts delta.
        let mut remote_posts: Vec<[u8; 32]> = remote.posts.iter().map(|m| m.0).collect();
        remote_posts.sort();
        let mut missing_posts = vec![];
        for post in &shard.posts {
            let hash = post_hash(post);
            if remote_posts.binary_search(&hash).is_err() {
                missing_posts.push(post.clone());
            }
        }

        // A `Posts` delta cannot convey the profile/follows registers. So if
        // either register differs, ship the full serialized shard as the delta
        // payload — `apply_delta_bytes` recognises a whole `UserShard` and
        // `merge_state`s it, reconciling every surface (posts ride along). When
        // only posts differ, the smaller `Posts` delta suffices.
        let local = ShardSummary::of(&shard);
        let registers_differ = local.profile != remote.profile || local.follows != remote.follows;

        let payload = if registers_differ {
            serde_json::to_vec(&shard)
        } else {
            serde_json::to_vec(&ShardDelta::Posts(missing_posts))
        };
        Ok(StateDelta::from(
            payload.map_err(|err| ContractError::Other(format!("{err}")))?,
        ))
    }
}

/// Parse a `ShardDelta` from raw delta bytes and apply it to the shard.
fn apply_delta_bytes(
    shard: &mut UserShard,
    bytes: &[u8],
    owner: &str,
) -> Result<(), ContractError> {
    // A delta is a `ShardDelta`. For backward tolerance also accept a bare
    // `Vec<Post>` (the Phase-1 posts-only wire form) and a full `UserShard`
    // object (a state shipped as a delta — see get_state_delta register path).
    if let Ok(d) = serde_json::from_slice::<ShardDelta>(bytes) {
        match d {
            ShardDelta::Posts(posts) => {
                for post in posts {
                    if post_is_acceptable(&post, owner) {
                        shard.posts.push(post);
                    }
                }
            }
            ShardDelta::Op(op) => {
                apply_op(shard, &op, owner);
            }
        }
        return Ok(());
    }
    if let Ok(posts) = serde_json::from_slice::<Vec<Post>>(bytes) {
        for post in posts {
            if post_is_acceptable(&post, owner) {
                shard.posts.push(post);
            }
        }
        return Ok(());
    }
    if let Ok(other) = serde_json::from_slice::<UserShard>(bytes) {
        merge_state(shard, other, owner);
        return Ok(());
    }
    Err(ContractError::InvalidDelta)
}

#[cfg(test)]
mod test {
    use super::*;
    use freenet_microblogging_common::signed_op::Profile;
    use ml_dsa::signature::{Keypair, Signer};
    use ml_dsa::{KeyGen, MlDsa65};

    fn owner_params(seed: [u8; 32]) -> Vec<u8> {
        let sk = MlDsa65::from_seed(&seed.into());
        sk.verifying_key().encode().to_vec()
    }

    fn params_of(seed: [u8; 32]) -> Parameters<'static> {
        Parameters::from(owner_params(seed))
    }

    fn vk_hex(seed: [u8; 32]) -> String {
        let sk = MlDsa65::from_seed(&seed.into());
        hex::encode(sk.verifying_key().encode())
    }

    fn signed_post(seed: [u8; 32], content: &str, timestamp: u64) -> Post {
        let sk = MlDsa65::from_seed(&seed.into());
        let author_pubkey = hex::encode(sk.verifying_key().encode());
        let mut p = Post {
            id: String::new(),
            author_pubkey,
            author_name: "Test User".to_string(),
            author_handle: "@testuser".to_string(),
            content: content.to_string(),
            timestamp,
            signature: None,
        };
        p.id = p.compute_id();
        let sig: ml_dsa::Signature<MlDsa65> = sk.sign(&p.signing_payload());
        p.signature = Some(hex::encode(sig.encode()));
        p
    }

    fn signed_op(seed: [u8; 32], op_type: OpType, payload: Vec<u8>, seq: u64) -> SignedOp {
        let sk = MlDsa65::from_seed(&seed.into());
        let mut op = SignedOp {
            op_type,
            payload,
            seq,
            signer_pubkey: hex::encode(sk.verifying_key().encode()),
            signature: None,
        };
        let sig: ml_dsa::Signature<MlDsa65> = sk.sign(&op.signing_payload());
        op.signature = Some(hex::encode(sig.encode()));
        op
    }

    fn profile_op(seed: [u8; 32], p: &Profile, seq: u64) -> SignedOp {
        signed_op(seed, OpType::Profile, serde_json::to_vec(p).unwrap(), seq)
    }

    fn follow_op(seed: [u8; 32], targets: &[&str], follow: bool, seq: u64) -> SignedOp {
        let targets: Vec<String> = targets.iter().map(|s| s.to_string()).collect();
        signed_op(
            seed,
            if follow {
                OpType::Follow
            } else {
                OpType::Unfollow
            },
            serde_json::to_vec(&targets).unwrap(),
            seq,
        )
    }

    fn apply(owner: [u8; 32], state: Vec<u8>, items: Vec<ShardDelta>) -> Vec<u8> {
        let deltas: Vec<UpdateData> = items
            .into_iter()
            .map(|d| UpdateData::Delta(StateDelta::from(serde_json::to_vec(&d).unwrap())))
            .collect();
        UserShard::update_state(params_of(owner), State::from(state), deltas)
            .unwrap()
            .unwrap_valid()
            .into_bytes()
    }

    fn empty_state() -> Vec<u8> {
        b"{}".to_vec()
    }

    fn sample_profile() -> Profile {
        Profile {
            display_name: "Alice".into(),
            handle: "@alice".into(),
            bio: "hi".into(),
            avatar: "blue".into(),
        }
    }

    #[test]
    fn posts_merge_dedup_and_owner_only() {
        let owner = [1u8; 32];
        let other = [2u8; 32];
        let p = signed_post(owner, "first", 1);
        let bytes = apply(
            owner,
            empty_state(),
            vec![ShardDelta::Posts(vec![
                p.clone(),
                p.clone(), // intra-batch duplicate
                signed_post(other, "foreign", 2),
            ])],
        );
        let shard: UserShard = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(shard.posts.len(), 1);
    }

    #[test]
    fn profile_lww_by_seq() {
        let owner = [1u8; 32];
        let mut p1 = sample_profile();
        p1.display_name = "v1".into();
        let mut p2 = sample_profile();
        p2.display_name = "v2".into();

        // Apply seq=2 then seq=1; higher seq must win regardless of order.
        let bytes = apply(
            owner,
            empty_state(),
            vec![
                ShardDelta::Op(profile_op(owner, &p2, 2)),
                ShardDelta::Op(profile_op(owner, &p1, 1)),
            ],
        );
        let shard: UserShard = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(shard.profile.unwrap().profile.display_name, "v2");
    }

    #[test]
    fn profile_rejects_oversized_and_foreign() {
        let owner = [1u8; 32];
        let other = [2u8; 32];

        // Oversized bio rejected.
        let mut big = sample_profile();
        big.bio = "x".repeat(10_000);
        let bytes = apply(
            owner,
            empty_state(),
            vec![ShardDelta::Op(profile_op(owner, &big, 1))],
        );
        let shard: UserShard = serde_json::from_slice(&bytes).unwrap();
        assert!(shard.profile.is_none());

        // Foreign signer rejected (signed by `other`, shard owned by `owner`).
        let bytes2 = apply(
            owner,
            empty_state(),
            vec![ShardDelta::Op(profile_op(other, &sample_profile(), 1))],
        );
        let shard2: UserShard = serde_json::from_slice(&bytes2).unwrap();
        assert!(shard2.profile.is_none());
    }

    #[test]
    fn follows_add_remove_converge() {
        let owner = [1u8; 32];
        let a = vk_hex([10u8; 32]);
        let b = vk_hex([11u8; 32]);

        // Follow a,b (seq1); unfollow a (seq2). a gone, b present.
        let bytes = apply(
            owner,
            empty_state(),
            vec![
                ShardDelta::Op(follow_op(owner, &[&a, &b], true, 1)),
                ShardDelta::Op(follow_op(owner, &[&a], false, 2)),
            ],
        );
        let shard: UserShard = serde_json::from_slice(&bytes).unwrap();
        assert!(!shard.follows.get(&a).unwrap().following);
        assert!(shard.follows.get(&b).unwrap().following);

        // Reorder: apply unfollow-a(seq2) BEFORE follow-a,b(seq1). Same result —
        // higher seq wins per key.
        let bytes2 = apply(
            owner,
            empty_state(),
            vec![
                ShardDelta::Op(follow_op(owner, &[&a], false, 2)),
                ShardDelta::Op(follow_op(owner, &[&a, &b], true, 1)),
            ],
        );
        let shard2: UserShard = serde_json::from_slice(&bytes2).unwrap();
        assert!(!shard2.follows.get(&a).unwrap().following);
        assert!(shard2.follows.get(&b).unwrap().following);
    }

    #[test]
    fn mixed_surfaces_in_one_update() {
        let owner = [1u8; 32];
        let a = vk_hex([10u8; 32]);
        let bytes = apply(
            owner,
            empty_state(),
            vec![
                ShardDelta::Posts(vec![signed_post(owner, "hello", 1)]),
                ShardDelta::Op(profile_op(owner, &sample_profile(), 1)),
                ShardDelta::Op(follow_op(owner, &[&a], true, 1)),
            ],
        );
        let shard: UserShard = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(shard.posts.len(), 1);
        assert_eq!(shard.profile.unwrap().profile.display_name, "Alice");
        assert!(shard.follows.get(&a).unwrap().following);
    }

    #[test]
    fn full_state_merge_reconciles_all_surfaces() {
        let owner = [1u8; 32];
        // Build a populated shard, serialize, feed it back as UpdateData::State
        // into an empty shard — all surfaces must transfer.
        let src = apply(
            owner,
            empty_state(),
            vec![
                ShardDelta::Posts(vec![signed_post(owner, "p", 1)]),
                ShardDelta::Op(profile_op(owner, &sample_profile(), 3)),
                ShardDelta::Op(follow_op(owner, &[&vk_hex([10u8; 32])], true, 1)),
            ],
        );
        let merged = UserShard::update_state(
            params_of(owner),
            State::from(empty_state()),
            vec![UpdateData::State(State::from(src))],
        )
        .unwrap()
        .unwrap_valid();
        let shard: UserShard = serde_json::from_slice(merged.as_ref()).unwrap();
        assert_eq!(shard.posts.len(), 1);
        assert_eq!(shard.profile.unwrap().seq, 3);
        assert_eq!(shard.follows.len(), 1);
    }

    #[test]
    fn validate_rejects_duplicate_ids() {
        let owner = [1u8; 32];
        let p = signed_post(owner, "dup", 1);
        let shard = UserShard {
            posts: vec![p.clone(), p],
            ..Default::default()
        };
        let res = UserShard::validate_state(
            params_of(owner),
            State::from(serde_json::to_vec(&shard).unwrap()),
            RelatedContracts::new(),
        )
        .unwrap();
        assert!(matches!(res, ValidateResult::Invalid));
    }

    #[test]
    fn validate_rejects_foreign_and_oversized_profile() {
        let owner = [1u8; 32];
        // Foreign-author post.
        let shard = UserShard {
            posts: vec![signed_post([2u8; 32], "x", 1)],
            ..Default::default()
        };
        assert!(matches!(
            UserShard::validate_state(
                params_of(owner),
                State::from(serde_json::to_vec(&shard).unwrap()),
                RelatedContracts::new(),
            )
            .unwrap(),
            ValidateResult::Invalid
        ));

        // Oversized profile register.
        let mut big = sample_profile();
        big.bio = "x".repeat(10_000);
        let shard2 = UserShard {
            profile: Some(ProfileRegister {
                profile: big,
                seq: 1,
            }),
            ..Default::default()
        };
        assert!(matches!(
            UserShard::validate_state(
                params_of(owner),
                State::from(serde_json::to_vec(&shard2).unwrap()),
                RelatedContracts::new(),
            )
            .unwrap(),
            ValidateResult::Invalid
        ));
    }

    #[test]
    fn validate_accepts_well_formed() {
        let owner = [1u8; 32];
        let bytes = apply(
            owner,
            empty_state(),
            vec![
                ShardDelta::Posts(vec![signed_post(owner, "ok", 1)]),
                ShardDelta::Op(profile_op(owner, &sample_profile(), 1)),
            ],
        );
        assert!(matches!(
            UserShard::validate_state(
                params_of(owner),
                State::from(bytes),
                RelatedContracts::new()
            )
            .unwrap(),
            ValidateResult::Valid
        ));
    }

    #[test]
    fn truncates_to_window() {
        let owner = [1u8; 32];
        let total = MAX_POSTS + 50;
        let mut all = Vec::with_capacity(total);
        for i in 0..total {
            all.push(signed_post(owner, &format!("post {i}"), i as u64));
        }
        let bytes = apply(owner, empty_state(), vec![ShardDelta::Posts(all)]);
        let shard: UserShard = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(shard.posts.len(), MAX_POSTS);
        let ts: Vec<u64> = shard.posts.iter().map(|p| p.timestamp).collect();
        assert!(ts.contains(&((total - 1) as u64)));
        assert!(!ts.contains(&0));
    }

    #[test]
    fn summary_changes_when_registers_change() {
        let owner = [1u8; 32];
        let base = apply(
            owner,
            empty_state(),
            vec![ShardDelta::Posts(vec![signed_post(owner, "p", 1)])],
        );
        let with_profile = apply(
            owner,
            base.clone(),
            vec![ShardDelta::Op(profile_op(owner, &sample_profile(), 1))],
        );
        let s1 = ShardSummary::of(&serde_json::from_slice::<UserShard>(&base).unwrap());
        let s2 = ShardSummary::of(&serde_json::from_slice::<UserShard>(&with_profile).unwrap());
        assert_ne!(s1.profile, s2.profile);
    }

    #[test]
    fn get_delta_ships_state_when_registers_differ() {
        let owner = [1u8; 32];
        // Local has a profile; remote summary has none → delta must carry the
        // full state so the profile reconciles. Feeding it back must restore it.
        let local = apply(
            owner,
            empty_state(),
            vec![ShardDelta::Op(profile_op(owner, &sample_profile(), 1))],
        );
        let remote_summary = ShardSummary {
            posts: vec![],
            profile: [0u8; 32],
            follows: [0u8; 32],
        };
        let delta = UserShard::get_state_delta(
            params_of(owner),
            State::from(local),
            StateSummary::from(serde_json::to_vec(&remote_summary).unwrap()),
        )
        .unwrap();
        // Apply the delta to an empty shard; profile must appear.
        let merged = UserShard::update_state(
            params_of(owner),
            State::from(empty_state()),
            vec![UpdateData::Delta(StateDelta::from(delta.to_vec()))],
        )
        .unwrap()
        .unwrap_valid();
        let shard: UserShard = serde_json::from_slice(merged.as_ref()).unwrap();
        assert!(shard.profile.is_some());
    }

    #[test]
    fn backward_compat_bare_post_array_delta() {
        // The Phase-1 posts-only wire form (a bare Vec<Post>) must still apply.
        let owner = [1u8; 32];
        let posts = vec![signed_post(owner, "legacy", 1)];
        let merged = UserShard::update_state(
            params_of(owner),
            State::from(empty_state()),
            vec![UpdateData::Delta(StateDelta::from(
                serde_json::to_vec(&posts).unwrap(),
            ))],
        )
        .unwrap()
        .unwrap_valid();
        let shard: UserShard = serde_json::from_slice(merged.as_ref()).unwrap();
        assert_eq!(shard.posts.len(), 1);
    }

    #[test]
    fn decodes_empty_and_old_shape() {
        let empty = UserShard::try_from(State::from(b"{}".as_ref())).unwrap();
        assert!(empty.posts.is_empty());
        assert!(empty.profile.is_none());
        assert!(empty.follows.is_empty());
    }
}
