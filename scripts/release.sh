#!/usr/bin/env bash
# End-to-end PRODUCTION release driver for freenet-microblogging (raven).
#
# Runs the whole production-release workflow as one command, stopping at
# each irreversible action for confirmation. See RELEASING.md for the
# narrative runbook.
#
# Preconditions (checked up front, fail fast):
#   • clean working tree on `main`
#   • tag vX.Y.Z does not already exist (local or origin)
#   • production key present (WEB_CONTAINER_KEY_FILE or default path)
#   • fdev, cargo-make, gh, GNU tar installed
#   • a network-connected Freenet node reachable (NOT a `freenet local`
#     sandbox — production publishes go to the real network)
#   • cargo make test + clippy pass
#
# Usage:
#     scripts/release.sh 0.1.0
#     scripts/release.sh 0.1.0 --yes   # auto-confirm all prompts

set -euo pipefail

VERSION="${1:-}"
ASSUME_YES=false
if [ "${2:-}" = "--yes" ] || [ "${1:-}" = "--yes" ]; then
    ASSUME_YES=true
    [ "${1:-}" = "--yes" ] && VERSION="${2:-}"
fi

if [ -z "$VERSION" ]; then
    echo "usage: scripts/release.sh <version> [--yes]" >&2
    echo "example: scripts/release.sh 0.1.0" >&2
    exit 2
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    echo "error: version must be semver (e.g. 0.1.0 or 0.1.0-rc.1)" >&2
    exit 2
fi

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

TAG="v$VERSION"
FREENET_PORT="${FREENET_PORT:-7509}"

confirm() {
    $ASSUME_YES && return 0
    read -r -p "$1 [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]]
}

die() { echo "error: $*" >&2; exit 1; }

# ─── Monotonic signing version ───────────────────────────────────────────────
#
# The on-chain web-container contract rejects any UPDATE whose version is
# <= the currently-published version (web/container/src/lib.rs). We derive a
# monotonic u32 from the release semver: major*1_000_000 + minor*1_000 + patch.
# This is deterministic, ties to the tag, and increases with every semver bump
# (minor/patch each capped at 999, which is plenty). The historical scheme —
# commit-hash bits — was effectively random and could sign a LOWER version
# than the previous release, which the contract silently rejected.
SEMVER_CORE="${VERSION%%-*}"   # drop any -rc.N suffix for the numeric pack
IFS='.' read -r MAJ MIN PAT <<<"$SEMVER_CORE"
if [ "$MIN" -gt 999 ] || [ "$PAT" -gt 999 ]; then
    die "minor/patch > 999 not supported by the packed version scheme ($VERSION)"
fi
WEBAPP_VERSION=$(( MAJ * 1000000 + MIN * 1000 + PAT ))
[ "$WEBAPP_VERSION" -gt 0 ] || die "packed version must be > 0 (got $WEBAPP_VERSION for $VERSION)"
export WEBAPP_VERSION

# Pin the sidebar version chip (web/vite.config.ts reads APP_VERSION) to the
# release tag. Without this the webapp builds BEFORE the git tag is created, so
# `git describe` bakes a stale `vPREV-N-gHASH` string instead of the clean
# `vX.Y.Z` we're releasing.
export APP_VERSION="$TAG"

# ─── 1. Preflight ──────────────────────────────────────────────────────────────
echo "── preflight ─────────────────────────────────────────────────────────────"

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "not on main"

git diff --quiet && git diff --cached --quiet || die "working tree dirty"

git fetch origin --tags
if git rev-parse "$TAG" >/dev/null 2>&1; then
    die "tag $TAG already exists locally (git tag -d $TAG to re-run)"
fi
if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
    die "tag $TAG already exists on origin"
fi

KEY_FILE="${WEB_CONTAINER_KEY_FILE:-$HOME/.config/freenet-microblogging/web-container-keys.toml}"
[ -f "$KEY_FILE" ] || die "production key missing at $KEY_FILE (run scripts/generate-production-key.sh)"

for cmd in fdev cargo-make gh; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd not on PATH"
done

# fdev must support --as-state for the facade pointer flip. Older builds
# silently wrap the state file as UpdateData::Delta; the facade contract's
# update_state only matches UpdateData::State and returns InvalidUpdate, so
# the pointer never moves and the stable URL serves a stale app. Only enforced
# when the facade has been published (facade-id.txt committed).
if [ -f published-contract/facade-id.txt ]; then
    if ! fdev execute update --help 2>&1 | grep -q -- '--as-state'; then
        die "fdev does not support \`--as-state\` (required for facade UPDATE).
Build a newer fdev: cargo install --path /path/to/freenet-core/crates/fdev"
    fi
fi

if ! command -v gtar >/dev/null 2>&1 && ! tar --version 2>/dev/null | grep -qi 'gnu tar'; then
    die "GNU tar required (macOS: brew install gnu-tar)"
fi

# Production publishes go to the REAL network, not a `freenet local` sandbox.
# Probe the HTTP gateway; warn (don't hard-fail) so an operator pointing at a
# non-default bind can still proceed deliberately.
if curl -fsS --max-time 3 "http://127.0.0.1:${FREENET_PORT}/" >/dev/null 2>&1 \
   || nc -z 127.0.0.1 "$FREENET_PORT" 2>/dev/null; then
    echo "  ✓ Freenet node reachable on :${FREENET_PORT}"
else
    echo "  ⚠️  could not reach a Freenet node at http://127.0.0.1:${FREENET_PORT}"
    echo "     Production publishes need \`freenet network\` (NOT \`freenet local\`)."
    echo "     Override the probe port with FREENET_PORT=... if your node binds elsewhere."
    confirm "Continue anyway?" || { echo "aborted"; exit 0; }
fi

# Monotonicity guard: if the contract is already published, its current state
# version must be < the version we are about to sign, or the UPDATE will be
# rejected on-network. Best-effort — only checks when we can read it back.
if [ -f published-contract/contract-id.txt ]; then
    CUR_ID=$(cat published-contract/contract-id.txt)
    SUMMARY=$(curl -fsS --max-time 5 \
        "http://127.0.0.1:${FREENET_PORT}/v1/contract/$CUR_ID/state-summary" 2>/dev/null || echo "")
    if [[ "$SUMMARY" =~ ([0-9]+) ]]; then
        PUBLISHED_VERSION="${BASH_REMATCH[1]}"
        if [ "$WEBAPP_VERSION" -le "$PUBLISHED_VERSION" ]; then
            die "packed version $WEBAPP_VERSION (from $VERSION) is <= currently-published version $PUBLISHED_VERSION.
The contract would reject this UPDATE. Bump the release version."
        fi
        echo "  ✓ signing version $WEBAPP_VERSION > published $PUBLISHED_VERSION"
    fi
fi

echo "preflight ✓ (signing version $WEBAPP_VERSION for $VERSION)"

# ─── 2. Test gate ──────────────────────────────────────────────────────────────
echo "── tests ─────────────────────────────────────────────────────────────────"
cargo make test
cargo make clippy
echo "tests ✓"

# ─── 3. First confirmation ─────────────────────────────────────────────────────
cat <<EOF

This will perform IRREVERSIBLE steps for $TAG:
  1. Build + sign webapp with PRODUCTION key (version $WEBAPP_VERSION)
  2. Update published-contract/ with new contract ID
  3. Publish webapp to the live Freenet network
  4. Commit published-contract/ on main
  5. Create annotated tag $TAG with auto-generated notes
  6. Push commit + tag to origin

EOF
confirm "Proceed?" || { echo "aborted"; exit 0; }

# ─── 4. Build, sign, publish ───────────────────────────────────────────────────
echo "── publish-production ────────────────────────────────────────────────────"
cargo make publish-production

NEW_ID=$(cat published-contract/contract-id.txt)
echo
echo "── new contract id: $NEW_ID ────────────────────────────────"

# ─── 4b. Facade pointer flip (issue #45 Phase 3) ──────────────────────────────
#
# The web-container contract id rotates every release, orphaning bookmarks.
# Users hit the FACADE contract instead — a stable, bookmarkable id whose
# signed state points at the current release's webapp. Each release we
# re-render the loader with the new current_app_id baked in, sign a fresh
# facade state (bumped version, production key — same key the web-container
# uses), and UPDATE the facade contract via `fdev --as-state`.
#
# Conditional: only runs once published-contract/facade-id.txt exists (the
# facade has been published once and its id committed — see RELEASING.md
# §"One-time facade publish"). Until then it warns + skips so the rest of
# the release still proceeds.
if [ -f published-contract/facade-id.txt ]; then
    FACADE_ID=$(tr -d '[:space:]' < published-contract/facade-id.txt)
    echo
    echo "── flipping facade pointer (issue #45) ───────────────────────────────────"
    echo "  facade contract id: $FACADE_ID"
    echo "  pointing at:        $NEW_ID"

    FACADE_CURRENT_APP_ID="$NEW_ID" cargo make build-facade-loader
    cargo make sign-facade-state

    FACADE_STATE="$ROOT/target/facade/facade.state"
    [ -f "$FACADE_STATE" ] || die "facade state not produced at $FACADE_STATE — sign step failed?"

    if confirm "Push facade UPDATE to the network now?"; then
        # --as-state: facade update_state only matches UpdateData::State; without
        # it fdev sends UpdateData::Delta and the contract rejects InvalidUpdate.
        fdev execute update --as-state "$FACADE_ID" "$FACADE_STATE"
        echo "  ✓ facade UPDATEd — bookmarked URL stays stable across releases"
    else
        echo "  ⚠️  skipped facade flip — webapp $NEW_ID is published but the facade still"
        echo "      points at the previous release. Resume manually with:"
        echo "        FACADE_CURRENT_APP_ID=$NEW_ID cargo make sign-facade-state"
        echo "        fdev execute update --as-state $FACADE_ID $FACADE_STATE"
    fi
else
    echo
    echo "  ⚠️  published-contract/facade-id.txt not committed — skipping facade flip."
    echo "      Publish the facade once (RELEASING.md §\"One-time facade publish\")"
    echo "      and commit its id to enable the stable bookmarkable URL."
fi

# ─── 5. Snapshot diff (unchanged-bytes is OK) ──────────────────────────────────
SNAPSHOT_CHANGED=1
if git diff --quiet -- published-contract/; then
    SNAPSHOT_CHANGED=0
    echo "  ⚠️  published-contract/ unchanged — wasm + parameters bit-identical to last release."
    echo "      A reproducible build can leave the snapshot byte-equal; the signature carries"
    echo "      the new version $WEBAPP_VERSION and was re-published. Will tag $TAG against HEAD"
    echo "      without an empty release commit."
else
    git --no-pager diff --stat -- published-contract/
fi

# ─── 6. Second confirmation ────────────────────────────────────────────────────
if [ "$SNAPSHOT_CHANGED" = "1" ]; then
    confirm "Commit published-contract/ and proceed to tag?" || {
        echo "aborted — published-contract/ left modified for inspection"; exit 0; }
    git add published-contract/
    git commit -m "release: $TAG

Contract ID: $NEW_ID
Signed version: $WEBAPP_VERSION
"
else
    confirm "Tag current HEAD as $TAG (no snapshot commit)?" || { echo "aborted"; exit 0; }
fi

# ─── 7. Tag ────────────────────────────────────────────────────────────────────
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$PREV_TAG" ]; then
    NOTES=$(git log --pretty=format:"- %s (%h)" "$PREV_TAG"..HEAD)
    RANGE="since $PREV_TAG"
else
    NOTES=$(git log --pretty=format:"- %s (%h)" HEAD)
    RANGE="initial release"
fi

git tag -a "$TAG" -m "$TAG

Contract ID: $NEW_ID
Signed version: $WEBAPP_VERSION

Changes $RANGE:
$NOTES
"

# ─── 8. Third confirmation + push ──────────────────────────────────────────────
echo
echo "── ready to push ────────────────────────────────────────────────────────"
echo "  git push origin main"
echo "  git push origin $TAG"
confirm "Push?" || {
    echo "stopped before push — run \`git push origin main && git push origin $TAG\` when ready"
    exit 0
}

git push origin main
git push origin "$TAG"

echo
echo "── released $TAG ──────────────────────────────────────────────────────────"
echo "  contract id:     $NEW_ID"
echo "  signed version:  $WEBAPP_VERSION"
if [ -f published-contract/facade-id.txt ]; then
    echo "  facade id:       $(tr -d '[:space:]' < published-contract/facade-id.txt) (stable bookmarkable URL)"
fi
echo
echo "Next: wait ~30s for propagation, then"
echo "  scripts/smoke-test-production.sh"
if [ -f published-contract/facade-id.txt ]; then
    echo
    echo "Smoke-test the STABLE facade URL (what users bookmark — survives releases):"
    echo "  http://127.0.0.1:${FREENET_PORT}/v1/contract/web/$(tr -d '[:space:]' < published-contract/facade-id.txt)/"
fi
