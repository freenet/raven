use ed25519_dalek::Signature;
use serde::{Deserialize, Serialize};

/// Metadata stored alongside the webapp. Format must stay stable: both the
/// signing tool (`tools/web-container-sign`) and the on-chain contract
/// (`web/container`) deserialize this struct from the same CBOR bytes.
#[derive(Serialize, Deserialize)]
pub struct WebContainerMetadata {
    pub version: u32,
    pub signature: Signature,
}
