#![allow(unexpected_cfgs)]
use freenet_microblogging_common::post::Post;
use freenet_stdlib::prelude::*;
use ml_dsa::signature::{Keypair, Signer};
use ml_dsa::{KeyGen, MlDsa65, SigningKey as MlDsaSigningKey};
use serde::{Deserialize, Serialize};

struct IdentityDelegate;

/// ML-DSA-65 secret seed length. The 32-byte seed is the storable secret;
/// `MlDsa65::from_seed` reconstructs the signing key (and hence the 1952-byte
/// verifying key) deterministically. Exported/imported as 64 hex chars.
const MLDSA_SEED_LEN: usize = 32;

/// Messages the web UI sends to the delegate.
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum Request {
    /// Generate a new keypair and store it. Returns the public key.
    CreateIdentity {
        handle: String,
        display_name: String,
    },
    /// Get the current public key and identity info.
    GetIdentity,
    /// Sign a post. The delegate builds the canonical signing payload from
    /// these fields (the single trusted encoder, `common::post`), derives the
    /// content-addressed id, and returns id + signature + public key.
    SignPost {
        content: String,
        author_name: String,
        author_handle: String,
        timestamp: u64,
    },
    /// Export the secret seed for backup/migration.
    ExportIdentity,
    /// Import a secret seed + identity from another device.
    ImportIdentity {
        secret_key: String, // hex-encoded 32-byte ML-DSA-65 secret seed
        display_name: String,
    },
}

/// Messages the delegate sends back to the web UI.
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum Response {
    Identity {
        public_key: String, // hex-encoded ML-DSA-65 VK (1952 bytes → 3904 hex)
        handle: String,
        display_name: String,
    },
    Signed {
        post_id: String,    // content-addressed id = blake3(signing payload)
        signature: String,  // hex-encoded ML-DSA-65 signature (3309 bytes)
        public_key: String, // hex-encoded VK
        timestamp: u64,     // echoed so the UI can match its pending draft
    },
    ExportedIdentity {
        secret_key: String, // hex-encoded 32-byte secret seed
        public_key: String, // hex-encoded VK
        display_name: String,
        handle: String,
    },
    Error {
        message: String,
    },
}

// Secret storage keys. The signing key is stored as its 32-byte SEED, not the
// expanded key — `MlDsa65::from_seed` reconstructs the key deterministically.
const SECRET_SEED: &[u8] = b"mldsa_seed";
const SECRET_HANDLE: &[u8] = b"handle";
const SECRET_DISPLAY_NAME: &[u8] = b"display_name";

/// Draw a fresh 32-byte ML-DSA seed from the Freenet kernel RNG.
///
/// `freenet_stdlib::rand::rand_bytes` calls the WASM host import
/// `__frnt__rand__rand_bytes` provided by the kernel, avoiding any dependency
/// on `getrandom` / OS entropy in WASM.
fn random_seed() -> [u8; MLDSA_SEED_LEN] {
    let bytes = freenet_stdlib::rand::rand_bytes(MLDSA_SEED_LEN as u32);
    let mut seed = [0u8; MLDSA_SEED_LEN];
    seed.copy_from_slice(&bytes[..MLDSA_SEED_LEN]);
    seed
}

/// Reconstruct the ML-DSA-65 signing key from a stored 32-byte seed.
fn signing_key_from_seed(seed: &[u8; MLDSA_SEED_LEN]) -> MlDsaSigningKey<MlDsa65> {
    MlDsa65::from_seed(&(*seed).into())
}

/// Hex-encode the verifying key derived from a signing key.
fn vk_hex(signing_key: &MlDsaSigningKey<MlDsa65>) -> String {
    hex::encode(signing_key.verifying_key().encode())
}

#[delegate]
impl DelegateInterface for IdentityDelegate {
    fn process(
        ctx: &mut DelegateCtx,
        _parameters: Parameters<'static>,
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
        // Verify origin — only accept calls from web apps.
        match &origin {
            Some(MessageOrigin::WebApp(_)) => {}
            _ => return Err(DelegateError::Other("only web app calls accepted".into())),
        }

        match message {
            InboundDelegateMsg::ApplicationMessage(app_msg) => {
                let request: Request = serde_json::from_slice(&app_msg.payload)
                    .map_err(|e| DelegateError::Other(format!("invalid request: {e}")))?;

                let response = match request {
                    Request::CreateIdentity {
                        handle,
                        display_name,
                    } => create_identity(ctx, &handle, &display_name),
                    Request::GetIdentity => get_identity(ctx),
                    Request::SignPost {
                        content,
                        author_name,
                        author_handle,
                        timestamp,
                    } => sign_post(ctx, &content, &author_name, &author_handle, timestamp),
                    Request::ExportIdentity => export_identity(ctx),
                    Request::ImportIdentity {
                        secret_key,
                        display_name,
                    } => import_identity(ctx, &secret_key, &display_name),
                };

                let response_bytes = serde_json::to_vec(&response)
                    .map_err(|e| DelegateError::Other(format!("serialize error: {e}")))?;

                Ok(vec![OutboundDelegateMsg::ApplicationMessage(
                    ApplicationMessage::new(response_bytes),
                )])
            }
            _ => Err(DelegateError::Other("unexpected message type".into())),
        }
    }
}

/// Load and validate the stored seed, returning a reconstructed signing key.
fn load_signing_key(ctx: &DelegateCtx) -> Result<MlDsaSigningKey<MlDsa65>, Response> {
    let Some(seed_bytes) = ctx.get_secret(SECRET_SEED) else {
        return Err(Response::Error {
            message: "no identity found — call CreateIdentity first".to_string(),
        });
    };
    let seed: [u8; MLDSA_SEED_LEN] = match seed_bytes.as_slice().try_into() {
        Ok(arr) => arr,
        Err(_) => {
            return Err(Response::Error {
                message: "stored seed has unexpected length".to_string(),
            });
        }
    };
    Ok(signing_key_from_seed(&seed))
}

fn stored_handle(ctx: &DelegateCtx) -> String {
    ctx.get_secret(SECRET_HANDLE)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

fn stored_display_name(ctx: &DelegateCtx) -> String {
    ctx.get_secret(SECRET_DISPLAY_NAME)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

fn create_identity(ctx: &mut DelegateCtx, handle: &str, display_name: &str) -> Response {
    let seed = random_seed();
    let signing_key = signing_key_from_seed(&seed);
    let public_key = vk_hex(&signing_key);
    // An empty handle from the UI means "derive one" — use the VK prefix.
    let handle = if handle.is_empty() {
        public_key[..8].to_string()
    } else {
        handle.to_string()
    };

    ctx.set_secret(SECRET_SEED, &seed);
    ctx.set_secret(SECRET_HANDLE, handle.as_bytes());
    ctx.set_secret(SECRET_DISPLAY_NAME, display_name.as_bytes());

    Response::Identity {
        public_key,
        handle,
        display_name: display_name.to_string(),
    }
}

fn get_identity(ctx: &DelegateCtx) -> Response {
    let signing_key = match load_signing_key(ctx) {
        Ok(k) => k,
        Err(resp) => return resp,
    };
    Response::Identity {
        public_key: vk_hex(&signing_key),
        handle: stored_handle(ctx),
        display_name: stored_display_name(ctx),
    }
}

fn sign_post(
    ctx: &DelegateCtx,
    content: &str,
    author_name: &str,
    author_handle: &str,
    timestamp: u64,
) -> Response {
    let signing_key = match load_signing_key(ctx) {
        Ok(k) => k,
        Err(resp) => return resp,
    };
    let public_key = vk_hex(&signing_key);

    // Build the canonical record and derive its content-addressed id with the
    // single trusted encoder (`common::post`), then sign that exact payload.
    let mut post = Post {
        id: String::new(),
        author_pubkey: public_key.clone(),
        author_name: author_name.to_string(),
        author_handle: author_handle.to_string(),
        content: content.to_string(),
        timestamp,
        signature: None,
    };
    post.id = post.compute_id();
    let signature: ml_dsa::Signature<MlDsa65> = signing_key.sign(&post.signing_payload());

    Response::Signed {
        post_id: post.id,
        signature: hex::encode(signature.encode()),
        public_key,
        timestamp,
    }
}

fn export_identity(ctx: &DelegateCtx) -> Response {
    let Some(seed_bytes) = ctx.get_secret(SECRET_SEED) else {
        return Response::Error {
            message: "no identity to export".to_string(),
        };
    };
    let seed: [u8; MLDSA_SEED_LEN] = match seed_bytes.as_slice().try_into() {
        Ok(arr) => arr,
        Err(_) => {
            return Response::Error {
                message: "stored seed has unexpected length".to_string(),
            };
        }
    };
    let signing_key = signing_key_from_seed(&seed);
    Response::ExportedIdentity {
        secret_key: hex::encode(seed),
        public_key: vk_hex(&signing_key),
        display_name: stored_display_name(ctx),
        handle: stored_handle(ctx),
    }
}

fn import_identity(ctx: &mut DelegateCtx, secret_key_hex: &str, display_name: &str) -> Response {
    let seed: [u8; MLDSA_SEED_LEN] = match hex::decode(secret_key_hex) {
        Ok(bytes) => match bytes.try_into() {
            Ok(arr) => arr,
            Err(_) => {
                return Response::Error {
                    message: "invalid secret key: must be 64 hex characters (32 bytes)".to_string(),
                };
            }
        },
        Err(_) => {
            return Response::Error {
                message: "invalid secret key: must be 64 hex characters (32 bytes)".to_string(),
            };
        }
    };

    let signing_key = signing_key_from_seed(&seed);
    let public_key = vk_hex(&signing_key);
    let handle = public_key[..8].to_string();

    ctx.set_secret(SECRET_SEED, &seed);
    ctx.set_secret(SECRET_HANDLE, handle.as_bytes());
    ctx.set_secret(SECRET_DISPLAY_NAME, display_name.as_bytes());

    Response::Identity {
        public_key,
        handle,
        display_name: display_name.to_string(),
    }
}
