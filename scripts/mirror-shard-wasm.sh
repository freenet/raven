#!/usr/bin/env bash
# Mirror a built parameterized shard contract into web/ for the browser to PUT,
# and verify the shipped wasm hashes to the node's code hash.
#
# Usage: mirror-shard-wasm.sh <ROOT> <wasm_basename> <web_basename>
#   ROOT          repo root (CARGO_MAKE_WORKING_DIRECTORY)
#   wasm_basename built artifact name, e.g. freenet_microblogging_thread_shard
#   web_basename  asset/code-hash stem under web/, e.g. thread_shard
#
# Background: parameterized shards have no single instance id — the browser
# derives each per-owner/per-thread key as blake3(code_hash || params) and PUTs
# the contract itself. The node re-hashes the PUT `data` to derive the key, so
# the browser must ship the RAW compiled wasm (target/…/<name>.wasm), NOT the
# packaged container (build/freenet/<name>, which has extra framing and a
# different blake3). `fdev inspect` reports the inner (raw) code hash from the
# packaged file; we mirror the raw wasm and then assert b3sum(raw) == that hash,
# failing the build on any drift (which would otherwise be a silent network-wide
# GET/PUT no-op).
set -euo pipefail

ROOT="$1"
WASM_NAME="$2"
WEB_STEM="$3"

WASM_PKG="$ROOT/contracts/${WEB_STEM//_/-}/build/freenet/$WASM_NAME"
WASM_RAW="$ROOT/target/wasm32-unknown-unknown/release/$WASM_NAME.wasm"

hash=$(CARGO_TARGET_DIR="$ROOT/target" fdev inspect "$WASM_PKG" code | \
    grep 'code hash:' | cut -d' ' -f3)

mkdir -p "$ROOT/build" "$ROOT/web/public"
printf '%s' "$hash" > "$ROOT/build/${WEB_STEM}_code_hash"
cp "$WASM_RAW" "$ROOT/web/public/$WEB_STEM.wasm"
printf '%s' "$hash" > "$ROOT/web/${WEB_STEM}_code_hash.txt"

# Verify hex(b3sum raw wasm) == hex(base58-decode(code hash)). The base58 decode
# uses a self-contained python3 (BITCOIN alphabet) — no npm dep, because
# contracts build before `npm install` populates web/node_modules in CI.
wasm_hex=$(b3sum --no-names "$ROOT/web/public/$WEB_STEM.wasm" | tr -d '[:space:]')
hash_hex=$(python3 -c '
import sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in sys.argv[1]:
    n = n * 58 + A.index(c)
sys.stdout.write(n.to_bytes(32, "big").hex())
' "$hash")
if [ "$wasm_hex" != "$hash_hex" ]; then
    echo "ERROR: shipped $WEB_STEM.wasm blake3 ($wasm_hex) != injected code hash ($hash_hex / $hash)" >&2
    echo "       Did you ship the packaged build/freenet container instead of the raw target wasm?" >&2
    exit 1
fi
echo "wrote build/${WEB_STEM}_code_hash + web/public/$WEB_STEM.wasm + web/${WEB_STEM}_code_hash.txt: $hash (verified blake3 match)"
