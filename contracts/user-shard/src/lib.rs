//! User shard contract (ADR-0001, Phase 1).
//!
//! One contract per user, **owner-writes only**. This phase carries the
//! windowed recent-posts surface; profile and follows land in later slices
//! (they share the same owner-writes / low-churn / read-by-followers axis, so
//! they belong in this same contract — see ADR-0001 → "User shard").
//!
//! ## Write authority — VK-param match
//!
//! The contract is parameterized by its owner's ML-DSA-65 verifying key (the
//! raw encoded VK bytes). A post is accepted iff:
//!   1. it self-verifies (`common::post::Post::verify` — content-addressed id
//!      matches the signed fields and the ML-DSA-65 signature is valid for
//!      `author_pubkey`), **and**
//!   2. its `author_pubkey` equals this contract's owner VK.
//!
//! (2) is what makes the shard owner-writes: a post signed by some *other*
//! valid key self-verifies but is not the owner's, so it is rejected. The owner
//! is whoever holds the seed for the parameter VK.
//!
//! ## Bounded state — post-merge count window
//!
//! The shard retains roughly the newest `MAX_POSTS` posts. Enforcement is a
//! **post-merge truncation**, not a pre-write check: concurrent appends from
//! different replicas can otherwise blow the bound at merge time. There is no
//! clock inside a contract, so "newest" is a deterministic ordering over the
//! merged set — `(timestamp, id)` descending — not a wall-clock decision. The
//! ordering is total and stable, so every replica truncates to the same set.

use freenet_microblogging_common::post::{MAX_CONTENT_LEN, Post};
use freenet_stdlib::prelude::{
    blake3::{Hasher as Blake3, traits::digest::Digest},
    *,
};
use serde::{Deserialize, Serialize};

/// Recent-post retention window. ADR-0001 starting policy: ~200.
const MAX_POSTS: usize = 200;

#[derive(Serialize, Deserialize)]
struct UserShard {
    // Schema-tolerance: defaults so older/newer wire shapes still decode.
    // See AGENTS.md → "Contract migration".
    #[serde(default)]
    posts: Vec<Post>,
}

impl<'a> TryFrom<State<'a>> for UserShard {
    type Error = ContractError;

    fn try_from(value: State<'a>) -> Result<Self, Self::Error> {
        serde_json::from_slice(value.as_ref()).map_err(|_| ContractError::InvalidState)
    }
}

/// The owner VK for this shard, taken from the contract parameters as a hex
/// string to compare against a post's `author_pubkey` (also hex).
///
/// Parameters are the raw encoded ML-DSA-65 VK bytes. Empty parameters yield an
/// empty owner key, which no real post can match — a shard with no owner accepts
/// no posts.
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

/// A post is acceptable iff it is within the length bound, self-verifies, and
/// its author is this shard's owner (owner-writes — ADR-0001).
fn post_is_acceptable(post: &Post, owner_vk_hex: &str) -> bool {
    post.content.len() <= MAX_CONTENT_LEN
        && post.author_pubkey == owner_vk_hex
        && post.verify().is_ok()
}

/// Deterministic "newest-first" ordering for the retention window: by author
/// timestamp descending, then by content-addressed id descending as a stable,
/// total tie-break. Used only to decide which posts survive truncation; it is
/// not the storage order (state is stored sorted by `post_hash` for merge).
fn newest_first(a: &Post, b: &Post) -> std::cmp::Ordering {
    b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id))
}

/// Keep only the newest `MAX_POSTS` after a merge, then restore the canonical
/// merge order (sorted by `post_hash`). Truncation is deterministic across
/// replicas because `newest_first` is a total order.
fn truncate_window(posts: &mut Vec<Post>) {
    if posts.len() > MAX_POSTS {
        posts.sort_by(newest_first);
        posts.truncate(MAX_POSTS);
    }
    posts.sort_by_cached_key(post_hash);
}

#[derive(Serialize, Deserialize)]
struct ShardSummary {
    summaries: Vec<MessageSummary>,
}

impl<'a> From<&'a mut UserShard> for ShardSummary {
    fn from(shard: &'a mut UserShard) -> Self {
        let mut summaries = Vec::with_capacity(shard.posts.len());
        for post in &shard.posts {
            summaries.push(MessageSummary(post_hash(post)));
        }
        ShardSummary { summaries }
    }
}

#[derive(Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct MessageSummary([u8; 32]);

impl<'a> TryFrom<StateSummary<'a>> for MessageSummary {
    type Error = ContractError;
    fn try_from(value: StateSummary<'a>) -> Result<Self, Self::Error> {
        serde_json::from_slice(&value).map_err(|_| ContractError::InvalidState)
    }
}

#[contract]
impl ContractInterface for UserShard {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts,
    ) -> Result<ValidateResult, ContractError> {
        let owner = owner_vk_hex(&parameters);
        let shard = UserShard::try_from(state)?;
        // The window is a post-merge convenience, not a validity invariant: a
        // state at exactly the bound is normal, and rejecting a transiently
        // over-bound state would break merge. Authority + self-verification are
        // the validity invariants we enforce here.
        for post in &shard.posts {
            if !post_is_acceptable(post, &owner) {
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
        shard.posts.sort_by_cached_key(post_hash);

        let delta_bytes = match &delta[0] {
            UpdateData::Delta(d) => d.as_ref(),
            UpdateData::State(s) => s.as_ref(),
            UpdateData::StateAndDelta { delta, .. } => delta.as_ref(),
            _ => {
                return Ok(UpdateModification::valid(State::from(
                    serde_json::to_vec(&shard).map_err(|e| ContractError::Other(format!("{e}")))?,
                )));
            }
        };
        let mut incoming = serde_json::from_slice::<Vec<Post>>(delta_bytes)
            .map_err(|_| ContractError::InvalidDelta)?;
        incoming.sort_by_cached_key(post_hash);

        for post in incoming {
            // Skip anything not owner-authored / not self-verifying / over the
            // length bound; a bad post in the batch is dropped, not fatal.
            if !post_is_acceptable(&post, &owner) {
                continue;
            }
            let key = post_hash(&post);
            if shard.posts.binary_search_by_key(&key, post_hash).is_err() {
                shard.posts.push(post);
            }
        }

        // Post-merge truncation to the retention window.
        truncate_window(&mut shard.posts);

        let shard_bytes =
            serde_json::to_vec(&shard).map_err(|err| ContractError::Other(format!("{err}")))?;
        Ok(UpdateModification::valid(State::from(shard_bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let mut shard = UserShard::try_from(state).unwrap();
        let only_posts = ShardSummary::from(&mut shard);
        Ok(StateSummary::from(
            serde_json::to_vec(&only_posts)
                .map_err(|err| ContractError::Other(format!("{err}")))?,
        ))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let shard = UserShard::try_from(state).unwrap();
        let mut summary = match serde_json::from_slice::<ShardSummary>(&summary) {
            Ok(summary) => summary,
            Err(_) => ShardSummary { summaries: vec![] },
        };
        summary.summaries.sort();
        let mut final_posts = vec![];
        for post in shard.posts {
            let hash = post_hash(&post);
            if summary
                .summaries
                .binary_search_by(|m| m.0.as_ref().cmp(&hash[..]))
                .is_err()
            {
                final_posts.push(post);
            }
        }
        Ok(StateDelta::from(
            serde_json::to_vec(&final_posts)
                .map_err(|err| ContractError::Other(format!("{err}")))?,
        ))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ml_dsa::signature::{Keypair, Signer};
    use ml_dsa::{KeyGen, MlDsa65};

    /// Owner VK (raw encoded bytes) for a seed, to use as contract parameters.
    fn owner_params(seed: [u8; 32]) -> Vec<u8> {
        let sk = MlDsa65::from_seed(&seed.into());
        sk.verifying_key().encode().to_vec()
    }

    /// Build a fully-signed post for `seed`'s identity (as the delegate would).
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

    fn params_of(seed: [u8; 32]) -> Parameters<'static> {
        Parameters::from(owner_params(seed))
    }

    #[test]
    fn conversions() -> Result<(), Box<dyn std::error::Error>> {
        let shard = UserShard {
            posts: vec![signed_post([1u8; 32], "Hello world", 1)],
        };
        let bytes = serde_json::to_vec(&shard)?;
        let _shard = UserShard::try_from(State::from(bytes))?;
        Ok(())
    }

    #[test]
    fn decodes_old_shape_state() -> Result<(), Box<dyn std::error::Error>> {
        // Schema-tolerance guard: an unknown forward-compat field and a post
        // missing `signature` must both still decode (decoding tolerance is
        // separate from acceptance).
        let json = r#"{
            "version": 2,
            "posts": [
                {
                    "id": "deadbeef",
                    "author_pubkey": "deadbeef",
                    "author_name": "Alice",
                    "author_handle": "@alice",
                    "content": "Hello world",
                    "timestamp": 1700000000000,
                    "reply_to": "future-field"
                }
            ]
        }"#;
        let shard = UserShard::try_from(State::from(json.as_bytes()))?;
        assert_eq!(shard.posts.len(), 1);
        assert!(shard.posts[0].signature.is_none());

        let empty = UserShard::try_from(State::from(b"{}".as_ref()))?;
        assert!(empty.posts.is_empty());
        Ok(())
    }

    #[test]
    fn validate_owner_post_is_valid() -> Result<(), Box<dyn std::error::Error>> {
        let owner = [1u8; 32];
        let shard = UserShard {
            posts: vec![signed_post(owner, "Hello!", 1)],
        };
        let valid = UserShard::validate_state(
            params_of(owner),
            State::from(serde_json::to_vec(&shard)?),
            RelatedContracts::new(),
        )?;
        assert!(matches!(valid, ValidateResult::Valid));
        Ok(())
    }

    #[test]
    fn validate_rejects_foreign_author() -> Result<(), Box<dyn std::error::Error>> {
        // A post signed by a DIFFERENT valid key self-verifies but is not the
        // owner's — owner-writes rejects it.
        let owner = [1u8; 32];
        let other = [2u8; 32];
        let shard = UserShard {
            posts: vec![signed_post(other, "Not the owner", 1)],
        };
        let invalid = UserShard::validate_state(
            params_of(owner),
            State::from(serde_json::to_vec(&shard)?),
            RelatedContracts::new(),
        )?;
        assert!(matches!(invalid, ValidateResult::Invalid));
        Ok(())
    }

    #[test]
    fn validate_rejects_tampered_and_unsigned() -> Result<(), Box<dyn std::error::Error>> {
        let owner = [1u8; 32];

        let mut tampered = signed_post(owner, "Hello!", 1);
        tampered.content = "tampered".to_string();
        let invalid = UserShard::validate_state(
            params_of(owner),
            State::from(serde_json::to_vec(&UserShard {
                posts: vec![tampered],
            })?),
            RelatedContracts::new(),
        )?;
        assert!(matches!(invalid, ValidateResult::Invalid));

        let mut unsigned = signed_post(owner, "Hello!", 1);
        unsigned.signature = None;
        let invalid2 = UserShard::validate_state(
            params_of(owner),
            State::from(serde_json::to_vec(&UserShard {
                posts: vec![unsigned],
            })?),
            RelatedContracts::new(),
        )?;
        assert!(matches!(invalid2, ValidateResult::Invalid));
        Ok(())
    }

    #[test]
    fn update_merges_owner_skips_foreign() -> Result<(), Box<dyn std::error::Error>> {
        let owner = [1u8; 32];
        let other = [2u8; 32];

        let p1 = signed_post(owner, "First", 1);
        let shard = UserShard {
            posts: vec![p1.clone()],
        };
        let state_bytes = serde_json::to_vec(&shard)?;

        // Delta carries one owner post and one foreign post; only the owner's
        // is merged.
        let delta = serde_json::to_vec(&vec![
            signed_post(owner, "Second", 2),
            signed_post(other, "Foreign", 3),
        ])?;
        let new_state = UserShard::update_state(
            params_of(owner),
            State::from(state_bytes),
            vec![UpdateData::Delta(StateDelta::from(delta))],
        )?
        .unwrap_valid();
        let updated: UserShard = serde_json::from_slice(new_state.as_ref())?;
        assert_eq!(updated.posts.len(), 2);

        // Commutativity: re-applying an existing post adds no duplicate.
        let dup = serde_json::to_vec(&vec![p1])?;
        let new_state2 = UserShard::update_state(
            params_of(owner),
            new_state,
            vec![UpdateData::Delta(StateDelta::from(dup))],
        )?
        .unwrap_valid();
        let updated2: UserShard = serde_json::from_slice(new_state2.as_ref())?;
        assert_eq!(updated2.posts.len(), 2);
        Ok(())
    }

    #[test]
    fn update_truncates_to_window() -> Result<(), Box<dyn std::error::Error>> {
        let owner = [1u8; 32];
        // Build MAX_POSTS + 50 owner posts, distinct content+timestamp.
        let total = MAX_POSTS + 50;
        let mut all = Vec::with_capacity(total);
        for i in 0..total {
            all.push(signed_post(owner, &format!("post {i}"), i as u64));
        }
        let delta = serde_json::to_vec(&all)?;
        let new_state = UserShard::update_state(
            params_of(owner),
            State::from(b"{}".to_vec()),
            vec![UpdateData::Delta(StateDelta::from(delta))],
        )?
        .unwrap_valid();
        let updated: UserShard = serde_json::from_slice(new_state.as_ref())?;
        assert_eq!(updated.posts.len(), MAX_POSTS);

        // The newest by (timestamp, id) survive: the highest timestamp must be
        // present, the lowest must be gone.
        let timestamps: Vec<u64> = updated.posts.iter().map(|p| p.timestamp).collect();
        assert!(timestamps.contains(&((total - 1) as u64)));
        assert!(!timestamps.contains(&0));
        Ok(())
    }

    #[test]
    fn truncation_is_deterministic_across_orderings() -> Result<(), Box<dyn std::error::Error>> {
        // Two replicas that received the same posts in different delta orders
        // must converge to the same windowed set.
        let owner = [1u8; 32];
        let total = MAX_POSTS + 10;
        let mut all = Vec::with_capacity(total);
        for i in 0..total {
            all.push(signed_post(owner, &format!("post {i}"), i as u64));
        }
        let mut reversed = all.clone();
        reversed.reverse();

        let apply = |posts: &Vec<Post>| -> Result<Vec<String>, Box<dyn std::error::Error>> {
            let delta = serde_json::to_vec(posts)?;
            let st = UserShard::update_state(
                params_of(owner),
                State::from(b"{}".to_vec()),
                vec![UpdateData::Delta(StateDelta::from(delta))],
            )?
            .unwrap_valid();
            let s: UserShard = serde_json::from_slice(st.as_ref())?;
            let mut ids: Vec<String> = s.posts.iter().map(|p| p.id.clone()).collect();
            ids.sort();
            Ok(ids)
        };

        assert_eq!(apply(&all)?, apply(&reversed)?);
        Ok(())
    }

    #[test]
    fn summarize_and_delta_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
        let owner = [1u8; 32];
        let p1 = signed_post(owner, "First", 1);
        let p2 = signed_post(owner, "Second", 2);
        let shard = UserShard {
            posts: vec![p1.clone(), p2.clone()],
        };
        let state_bytes = serde_json::to_vec(&shard)?;

        let summary = ShardSummary::from(&mut UserShard { posts: vec![p1] });
        let delta = UserShard::get_state_delta(
            params_of(owner),
            State::from(state_bytes),
            serde_json::to_vec(&summary).unwrap().into(),
        )?;
        let delta_posts: Vec<Post> = serde_json::from_slice(delta.as_ref())?;
        assert_eq!(delta_posts.len(), 1);
        assert_eq!(delta_posts[0].id, p2.id);
        Ok(())
    }
}
