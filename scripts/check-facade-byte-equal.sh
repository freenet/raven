#!/usr/bin/env bash
# Issue #45 (Phase 4).
#
# The facade contract's reason to exist is a STABLE contract id across
# releases — that id is the bookmarkable URL users keep. The id is
# hash(facade.wasm, facade.parameters); facade.wasm must stay byte-identical
# release-to-release. This script rebuilds the facade wasm from source and
# compares it against the committed published-contract/facade.wasm.
#
# A drift here means a dependency or rustc change leaked into facade.wasm
# (e.g. a freenet-stdlib / ed25519-dalek / byteorder pin bump under
# contracts/facade/Cargo.toml, or a rust-toolchain.toml bump). That rotates
# the facade contract id and breaks every bookmarked URL. Either fix the
# regression OR consciously accept the rotation, regenerate the committed
# snapshot via scripts/build-facade-snapshot-linux.sh, and bump the docs.
#
# Note: this checks only facade.wasm. facade.parameters is the publisher's
# 32-byte verifying key (the production identity), orthogonal to the build —
# it is not produced here and not compared.
#
# Snapshot canonicalization: the committed bytes are produced on linux/amd64
# with the rustc pinned in rust-toolchain.toml. CI runs on linux/amd64 with
# the same pin, so the rebuild matches. Other host arch/OS combos (e.g.
# macOS arm64 dev machines) produce different wasm bytes — same source,
# different codegen — and would trigger a spurious failure. Detect
# non-canonical hosts and skip with a warning so local devs aren't blocked.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Issue #45: facade lives in its own workspace at contracts/facade/ with a
# separate Cargo.lock. Build artifacts go under contracts/facade/target/.
WASM_OUT="$ROOT/contracts/facade/target/wasm32-unknown-unknown/release/freenet_microblogging_facade.wasm"
COMMITTED="$ROOT/published-contract/facade.wasm"

if [ ! -f "$COMMITTED" ]; then
    echo "warn: $COMMITTED missing — facade not yet bootstrapped on any network."
    echo "      The one-time publish (RELEASING.md §\"One-time facade publish\")"
    echo "      commits the snapshot; until then this gate is a no-op. Skipping."
    exit 0
fi

# Snapshot canonicalization. The committed bytes only match rebuilds on the
# same canonical host the snapshot was produced on: linux/amd64 with the
# pinned rustc. Skip with a warning otherwise.
HOST_OS=$(uname -s)
HOST_ARCH=$(uname -m)
if [ "$HOST_OS" != "Linux" ] || [ "$HOST_ARCH" != "x86_64" ]; then
    echo "warn: facade byte-equality check is canonical only on linux/amd64."
    echo "      This host is $HOST_OS/$HOST_ARCH — skipping rebuild + compare."
    echo "      To rebuild the snapshot deliberately, run:"
    echo "        scripts/build-facade-snapshot-linux.sh"
    exit 0
fi

# Build with the facade's own manifest + lockfile (issue #45). The release
# pipeline builds with --no-default-features --features freenet-main-contract
# (see Makefile.toml [tasks.build-facade]); match it so the bytes line up.
(
    cd "$ROOT/contracts/facade"
    cargo build --release --target wasm32-unknown-unknown \
        --no-default-features --features freenet-main-contract
)

if ! cmp -s "$WASM_OUT" "$COMMITTED"; then
    echo "FAIL: facade wasm drift detected." >&2
    echo "  built:     $WASM_OUT ($(wc -c < "$WASM_OUT") bytes, $(shasum -a 256 "$WASM_OUT" | cut -d' ' -f1))" >&2
    echo "  committed: $COMMITTED ($(wc -c < "$COMMITTED") bytes, $(shasum -a 256 "$COMMITTED" | cut -d' ' -f1))" >&2
    echo "" >&2
    echo "If this drift is intentional (a deliberate facade upgrade), regenerate" >&2
    echo "the committed snapshot on linux/amd64:" >&2
    echo "  scripts/build-facade-snapshot-linux.sh" >&2
    echo "  git add published-contract/facade.wasm published-contract/facade-id.txt" >&2
    echo "Then update RELEASING.md to record the new facade id. NOTE: rotating the" >&2
    echo "facade id breaks every bookmarked URL — do this only deliberately." >&2
    exit 1
fi

echo "ok: facade wasm matches committed snapshot ($(wc -c < "$COMMITTED") bytes)"
