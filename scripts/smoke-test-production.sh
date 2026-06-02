#!/usr/bin/env bash
# Production liveness check for a deployed freenet-microblogging webapp.
#
# Usage:
#     scripts/smoke-test-production.sh [gateway-url]
#
# With no argument, defaults to the local `freenet network` gateway serving
# the contract id from published-contract/contract-id.txt. Pass an explicit
# URL to test against a remote peer:
#
#     scripts/smoke-test-production.sh http://peer.example:7509/v1/contract/web/<id>/
#
# Override the default port with FREENET_PORT=... .

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
FREENET_PORT="${FREENET_PORT:-7509}"

URL="${1:-}"
if [ -z "$URL" ]; then
    if [ ! -f "$ROOT/published-contract/contract-id.txt" ]; then
        echo "usage: $0 [gateway-url]" >&2
        echo "       (no published-contract/contract-id.txt to auto-derive from)" >&2
        exit 1
    fi
    CONTRACT_ID=$(cat "$ROOT/published-contract/contract-id.txt")
    URL="http://127.0.0.1:${FREENET_PORT}/v1/contract/web/$CONTRACT_ID/"
    echo "no URL supplied; defaulting to local freenet network gateway:"
    echo "  $URL"
fi

# The gateway should return something before we spin up browsers.
if ! curl -fsS -o /dev/null --max-time 5 "$URL" 2>/dev/null; then
    echo "error: $URL is not responding" >&2
    echo "" >&2
    echo "Make sure:" >&2
    echo "  1. \`freenet network\` is running and connected" >&2
    echo "  2. the contract has propagated (wait ~30s after publish)" >&2
    echo "  3. the URL is correct (default port $FREENET_PORT; override with FREENET_PORT=...)" >&2
    exit 1
fi

if [ ! -d "$ROOT/web/tests/node_modules" ]; then
    echo "error: web/tests/node_modules missing. Run:" >&2
    echo "  cargo make test-ui-playwright-setup" >&2
    exit 1
fi

echo "smoke-testing $URL"
cd "$ROOT/web/tests"
BASE_URL="$URL" npx playwright test production-liveness.spec.ts

echo ""
echo "✅ liveness check passed against $URL"
