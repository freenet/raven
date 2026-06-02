#!/usr/bin/env bash
# Issue #45 (Phase 4). Rebuild published-contract/facade.{wasm,id.txt} from
# source. ONLY canonical on native linux/amd64 hosts — bytes produced under
# qemu emulation (Docker on macOS / arm64) drift slightly even with identical
# rustc + source, so emulated rebuilds WILL NOT match the CI byte-equality
# gate (scripts/check-facade-byte-equal.sh).
#
# Use this when:
#   • Bumping rustc in rust-toolchain.toml.
#   • Bumping a `=x.y.z` pin under contracts/facade/Cargo.toml or
#     contracts/facade-types/Cargo.toml.
#   • Editing facade source.
#
# On non-Linux/amd64 hosts: do NOT use this. Rely on the CI bootstrap path:
#   1. Push the change with whatever facade.wasm bytes you have locally.
#   2. check-contract-wasm.yml fails byte-equality and uploads the canonical
#      CI-built wasm as artifact `facade-wasm-rebuilt-<sha>`.
#   3. Download it, replace published-contract/facade.wasm, recompute
#      facade-id.txt via `fdev get-contract-id`, commit, push.
#   4. CI passes.
#
# This script reuses the existing facade.parameters (the 32-byte production
# verifying key — the publisher identity, orthogonal to the build). It does
# NOT mint parameters; a first-ever bootstrap mints them via
# `cargo make publish-facade` with the production key (see RELEASING.md).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Read the pinned channel from rust-toolchain.toml so a rebuild is only
# attempted when the toolchain is actually pinned (an unpinned "stable" would
# make the snapshot non-reproducible the moment the channel advances).
PINNED_RUSTC=$(awk -F'"' '/^channel/ {print $2; exit}' rust-toolchain.toml 2>/dev/null || echo "")
if [ -z "$PINNED_RUSTC" ] || [ "$PINNED_RUSTC" = "stable" ]; then
    echo "warn: rust-toolchain.toml has no explicit version pin (channel=${PINNED_RUSTC:-unset})." >&2
    echo "      facade.wasm bytes are rustc-sensitive; an unpinned channel means the" >&2
    echo "      snapshot will silently drift when stable advances. Pin an exact version" >&2
    echo "      (e.g. 1.95.0) for a durable snapshot. Continuing with the active toolchain." >&2
fi

HOST_OS=$(uname -s)
HOST_ARCH=$(uname -m)
if [ "$HOST_OS" != "Linux" ] || [ "$HOST_ARCH" != "x86_64" ]; then
    echo "error: this host is $HOST_OS/$HOST_ARCH; canonical snapshot bytes can only" >&2
    echo "       be produced on native linux/amd64 (qemu emulation drifts vs CI)." >&2
    echo "       Use the CI bootstrap path documented at the top of this script." >&2
    exit 1
fi

WASM_OUT="$ROOT/contracts/facade/target/wasm32-unknown-unknown/release/freenet_microblogging_facade.wasm"

echo "→ building facade natively (linux/amd64, rustc ${PINNED_RUSTC:-active})"
(
    cd "$ROOT/contracts/facade"
    cargo build --release --target wasm32-unknown-unknown \
        --no-default-features --features freenet-main-contract
)
[ -f "$WASM_OUT" ] || { echo "error: build succeeded but $WASM_OUT does not exist" >&2; exit 1; }

PARAMS="$ROOT/published-contract/facade.parameters"
if [ ! -f "$PARAMS" ]; then
    echo "error: $PARAMS not found." >&2
    echo "       For a first-ever bootstrap, publish the facade once with the" >&2
    echo "       production key (RELEASING.md §\"One-time facade publish\") to mint" >&2
    echo "       parameters, then re-run this to overwrite wasm with canonical bytes." >&2
    exit 1
fi

cp "$WASM_OUT" "$ROOT/published-contract/facade.wasm"

NEW_ID=$(CARGO_TARGET_DIR="$ROOT/target" fdev get-contract-id \
    --code "$ROOT/published-contract/facade.wasm" \
    --parameters "$PARAMS")
[ -n "$NEW_ID" ] || { echo "error: fdev get-contract-id returned empty id" >&2; exit 1; }
printf '%s\n' "$NEW_ID" > "$ROOT/published-contract/facade-id.txt"

echo
echo "✓ facade snapshot regenerated:"
echo "    facade-id.txt    = $NEW_ID"
echo "    facade.wasm      = $(wc -c < "$ROOT/published-contract/facade.wasm") bytes"
echo "    facade.parameters= $(wc -c < "$PARAMS") bytes (unchanged — publisher key)"
echo
echo "Commit the published-contract/ diff alongside the change that rotated the"
echo "bytes. The CI byte-equality gate fails until both land in the same PR."
echo "If facade-id.txt changed, every bookmarked URL just broke — make sure that"
echo "was intentional and announce the migration."
