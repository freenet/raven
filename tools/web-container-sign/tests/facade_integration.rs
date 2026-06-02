//! End-to-end check: bytes produced by the `sign-facade-state` subcommand must
//! be accepted by the on-chain `FacadeContract::validate_state`.
//!
//! The unit tests in the facade contract re-implement framing manually, so a
//! divergence between signer and contract would not show up there. This test
//! composes both sides for real, driving the actual CLI binary a release script
//! would invoke. Issue #45.

use std::process::Command;

use freenet_microblogging_facade::FacadeContract;
use freenet_stdlib::prelude::*;

#[test]
fn signed_facade_state_validates_against_on_chain_contract() {
    let dir = tempfile::tempdir().unwrap();
    let key_file = dir.path().join("keys.toml");
    let loader = dir.path().join("loader.tar.xz");
    let state_path = dir.path().join("facade.state");
    let params_path = dir.path().join("facade.parameters");

    // Use the binary itself, not internal helpers — exercises the full CLI
    // pipeline a release script would invoke.
    let bin = env!("CARGO_BIN_EXE_web-container-sign");

    // Generate a key.
    let status = Command::new(bin)
        .args(["generate", "--output"])
        .arg(&key_file)
        .status()
        .unwrap();
    assert!(status.success(), "generate command failed");

    // The signer treats loader bytes as opaque (it signs over them); any blob
    // works for the framing/signature round-trip this test checks.
    let app_id = [0xAAu8; 32];
    let app_id_b58 = bs58::encode(app_id).into_string();
    std::fs::write(&loader, b"pretend this is loader.tar.xz").unwrap();

    let status = Command::new(bin)
        .args(["sign-facade-state", "--loader"])
        .arg(&loader)
        .args(["--current-app-id", &app_id_b58])
        .args(["--version", "12345"])
        .arg("--key-file")
        .arg(&key_file)
        .arg("--output")
        .arg(&state_path)
        .arg("--parameters")
        .arg(&params_path)
        .status()
        .unwrap();
    assert!(status.success(), "sign-facade-state command failed");

    let parameters = std::fs::read(&params_path).unwrap();
    let state_bytes = std::fs::read(&state_path).unwrap();

    let result = FacadeContract::validate_state(
        Parameters::from(parameters),
        State::from(state_bytes),
        RelatedContracts::default(),
    );
    assert!(
        matches!(result, Ok(ValidateResult::Valid)),
        "on-chain validate_state rejected signer output: {result:?}"
    );
}
