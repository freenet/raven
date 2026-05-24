use freenet_microblogging_common::post::{MAX_CONTENT_LEN, Post};
use freenet_stdlib::prelude::{
    blake3::{Hasher as Blake3, traits::digest::Digest},
    *,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct PostsFeed {
    // Schema-tolerance: defaults so older/newer wire shapes still decode.
    // See AGENTS.md → "Contract migration".
    #[serde(default)]
    posts: Vec<Post>,
}

impl<'a> TryFrom<State<'a>> for PostsFeed {
    type Error = ContractError;

    fn try_from(value: State<'a>) -> Result<Self, Self::Error> {
        serde_json::from_slice(value.as_ref()).map_err(|_| ContractError::InvalidState)
    }
}

/// Dedup/summary key for a post: blake3 over its content-addressed id.
/// (The id is itself a content address, so distinct ids are distinct posts;
/// hashing it to a fixed `[u8; 32]` keeps the existing summary machinery.)
fn post_hash(post: &Post) -> [u8; 32] {
    let mut hasher = Blake3::new();
    hasher.update(post.id.as_bytes());
    let hash_val = hasher.finalize();
    let mut key = [0; 32];
    key.copy_from_slice(&hash_val[..]);
    key
}

/// A post is acceptable iff it is within the length bound and fully
/// self-verifies: content-addressed id matches the signed fields and the
/// ML-DSA-65 signature is valid for `author_pubkey` (ADR-0001 → owner-writes).
fn post_is_acceptable(post: &Post) -> bool {
    post.content.len() <= MAX_CONTENT_LEN && post.verify().is_ok()
}

#[derive(Serialize, Deserialize)]
struct FeedSummary {
    summaries: Vec<MessageSummary>,
}

impl<'a> From<&'a mut PostsFeed> for FeedSummary {
    fn from(feed: &'a mut PostsFeed) -> Self {
        let mut summaries = Vec::with_capacity(feed.posts.len());
        for post in &feed.posts {
            summaries.push(MessageSummary(post_hash(post)));
        }
        FeedSummary { summaries }
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
impl ContractInterface for PostsFeed {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts,
    ) -> Result<ValidateResult, ContractError> {
        let feed = PostsFeed::try_from(state)?;
        for post in &feed.posts {
            // Every stored post must self-verify (content-address id + valid
            // ML-DSA-65 signature) and respect the length bound.
            if !post_is_acceptable(post) {
                return Ok(ValidateResult::Invalid);
            }
        }
        Ok(ValidateResult::Valid)
    }

    fn update_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        delta: Vec<UpdateData>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        if delta.is_empty() {
            return Ok(UpdateModification::valid(state));
        }
        let mut feed = PostsFeed::try_from(state)?;
        feed.posts.sort_by_cached_key(post_hash);

        let delta_bytes = match &delta[0] {
            UpdateData::Delta(d) => d.as_ref(),
            UpdateData::State(s) => s.as_ref(),
            UpdateData::StateAndDelta { delta, .. } => delta.as_ref(),
            _ => {
                return Ok(UpdateModification::valid(State::from(
                    serde_json::to_vec(&feed).map_err(|e| ContractError::Other(format!("{e}")))?,
                )));
            }
        };
        let mut incoming = serde_json::from_slice::<Vec<Post>>(delta_bytes)
            .map_err(|_| ContractError::InvalidDelta)?;
        incoming.sort_by_cached_key(post_hash);

        for post in incoming {
            // Skip anything that doesn't self-verify or breaks the length bound;
            // a bad post in the batch is dropped, not fatal to the whole update.
            if !post_is_acceptable(&post) {
                continue;
            }
            let key = post_hash(&post);
            if feed.posts.binary_search_by_key(&key, post_hash).is_err() {
                feed.posts.push(post);
            }
        }

        let feed_bytes =
            serde_json::to_vec(&feed).map_err(|err| ContractError::Other(format!("{err}")))?;
        Ok(UpdateModification::valid(State::from(feed_bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let mut feed = PostsFeed::try_from(state).unwrap();
        let only_posts = FeedSummary::from(&mut feed);
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
        let feed = PostsFeed::try_from(state).unwrap();
        let mut summary = match serde_json::from_slice::<FeedSummary>(&summary) {
            Ok(summary) => summary,
            Err(_) => {
                // empty summary
                FeedSummary { summaries: vec![] }
            }
        };
        summary.summaries.sort();
        let mut final_posts = vec![];
        for post in feed.posts {
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

    /// Build a fully-signed post for `seed`'s identity (the way the delegate
    /// would): content-addressed id + valid ML-DSA-65 signature.
    fn signed_post(seed: [u8; 32], content: &str) -> Post {
        let sk = MlDsa65::from_seed(&seed.into());
        let author_pubkey = hex::encode(sk.verifying_key().encode());
        let mut p = Post {
            id: String::new(),
            author_pubkey,
            author_name: "Test User".to_string(),
            author_handle: "@testuser".to_string(),
            content: content.to_string(),
            timestamp: 1_700_000_000_000,
            signature: None,
        };
        p.id = p.compute_id();
        let sig: ml_dsa::Signature<MlDsa65> = sk.sign(&p.signing_payload());
        p.signature = Some(hex::encode(sig.encode()));
        p
    }

    #[test]
    fn conversions() -> Result<(), Box<dyn std::error::Error>> {
        let feed = PostsFeed {
            posts: vec![signed_post([1u8; 32], "Hello world")],
        };
        let bytes = serde_json::to_vec(&feed)?;
        let _feed = PostsFeed::try_from(State::from(bytes))?;
        Ok(())
    }

    #[test]
    fn decodes_old_shape_state() -> Result<(), Box<dyn std::error::Error>> {
        // Schema-tolerance guard: a post missing `signature` (older wire shape)
        // and a feed carrying an unknown forward-compat field must both decode.
        // (Decoding tolerance is separate from acceptance — such a post would
        // fail verification, but it must still deserialize.)
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
        let feed = PostsFeed::try_from(State::from(json.as_bytes()))?;
        assert_eq!(feed.posts.len(), 1);
        assert!(feed.posts[0].signature.is_none());

        // An empty object decodes to an empty feed (posts defaults).
        let empty = PostsFeed::try_from(State::from(b"{}".as_ref()))?;
        assert!(empty.posts.is_empty());
        Ok(())
    }

    #[test]
    fn validate_state() -> Result<(), Box<dyn std::error::Error>> {
        // A correctly-signed post is valid.
        let feed = PostsFeed {
            posts: vec![signed_post([1u8; 32], "Hello!")],
        };
        let valid = PostsFeed::validate_state(
            [].as_ref().into(),
            State::from(serde_json::to_vec(&feed)?),
            RelatedContracts::new(),
        )?;
        assert!(matches!(valid, ValidateResult::Valid));

        // Tampered content (signature no longer matches) is rejected.
        let mut tampered = signed_post([1u8; 32], "Hello!");
        tampered.content = "tampered".to_string();
        let feed_t = PostsFeed {
            posts: vec![tampered],
        };
        let invalid = PostsFeed::validate_state(
            [].as_ref().into(),
            State::from(serde_json::to_vec(&feed_t)?),
            RelatedContracts::new(),
        )?;
        assert!(matches!(invalid, ValidateResult::Invalid));

        // Unsigned post is rejected.
        let mut unsigned = signed_post([1u8; 32], "Hello!");
        unsigned.signature = None;
        let feed_u = PostsFeed {
            posts: vec![unsigned],
        };
        let invalid2 = PostsFeed::validate_state(
            [].as_ref().into(),
            State::from(serde_json::to_vec(&feed_u)?),
            RelatedContracts::new(),
        )?;
        assert!(matches!(invalid2, ValidateResult::Invalid));

        Ok(())
    }

    #[test]
    fn update_state() -> Result<(), Box<dyn std::error::Error>> {
        let post1 = signed_post([1u8; 32], "First post");
        let feed = PostsFeed {
            posts: vec![post1.clone()],
        };
        let state_bytes = serde_json::to_vec(&feed)?;

        let post2 = signed_post([2u8; 32], "Second post");
        let delta = StateDelta::from(serde_json::to_vec(&vec![post2.clone()])?);

        let new_state = PostsFeed::update_state(
            [].as_ref().into(),
            State::from(state_bytes),
            vec![UpdateData::Delta(delta)],
        )?
        .unwrap_valid();
        let updated_feed: PostsFeed = serde_json::from_slice(new_state.as_ref())?;
        assert_eq!(updated_feed.posts.len(), 2);

        // Commutativity: re-applying an existing post adds no duplicate.
        let duplicate_delta = serde_json::to_vec(&vec![post1])?;
        let new_state2 = PostsFeed::update_state(
            [].as_ref().into(),
            new_state,
            vec![UpdateData::Delta(StateDelta::from(duplicate_delta))],
        )?
        .unwrap_valid();
        let feed2: PostsFeed = serde_json::from_slice(new_state2.as_ref())?;
        assert_eq!(feed2.posts.len(), 2);

        // A tampered post in the batch is skipped, not fatal.
        let mut tampered = signed_post([3u8; 32], "Third post");
        tampered.content = "tampered after signing".to_string();
        let bad_delta = serde_json::to_vec(&vec![tampered])?;
        let new_state3 = PostsFeed::update_state(
            [].as_ref().into(),
            new_state2,
            vec![UpdateData::Delta(StateDelta::from(bad_delta))],
        )?
        .unwrap_valid();
        let feed3: PostsFeed = serde_json::from_slice(new_state3.as_ref())?;
        assert_eq!(feed3.posts.len(), 2); // tampered post skipped

        Ok(())
    }

    #[test]
    fn summarize_state() -> Result<(), Box<dyn std::error::Error>> {
        let feed = PostsFeed {
            posts: vec![signed_post([1u8; 32], "Hello!")],
        };
        let summary = PostsFeed::summarize_state(
            [].as_ref().into(),
            State::from(serde_json::to_vec(&feed)?),
        )?;
        let feed_summary = serde_json::from_slice::<FeedSummary>(summary.as_ref()).unwrap();
        assert_eq!(feed_summary.summaries.len(), 1);
        Ok(())
    }

    #[test]
    fn get_state_delta() -> Result<(), Box<dyn std::error::Error>> {
        let post1 = signed_post([1u8; 32], "First post");
        let post2 = signed_post([2u8; 32], "Second post");
        let feed = PostsFeed {
            posts: vec![post1.clone(), post2.clone()],
        };
        let state_bytes = serde_json::to_vec(&feed)?;

        // Summary only contains post1 — delta should return post2.
        let summary = FeedSummary::from(&mut PostsFeed { posts: vec![post1] });
        let delta = PostsFeed::get_state_delta(
            [].as_ref().into(),
            State::from(state_bytes),
            serde_json::to_vec(&summary).unwrap().into(),
        )?;

        let delta_posts: Vec<Post> = serde_json::from_slice(delta.as_ref())?;
        assert_eq!(delta_posts.len(), 1);
        assert_eq!(delta_posts[0].id, post2.id);
        Ok(())
    }
}
