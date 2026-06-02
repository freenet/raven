# Releasing freenet-microblogging

## One-time setup (per release operator)

1. Generate the production signing key:

   ```bash
   scripts/generate-production-key.sh
   ```

   Writes `~/.config/freenet-microblogging/web-container-keys.toml` with `chmod 600`.

2. Back it up immediately (offline, encrypted). The key cannot be recovered.

3. Install prerequisites:

   ```bash
   cargo install cargo-make fdev
   brew install gnu-tar gh    # macOS — Linux ships GNU tar
   ```

4. Start a **network-connected** Freenet node in another terminal.
   Production publishes go to the real network, NOT a `freenet local`
   sandbox:

   ```bash
   freenet network
   ```

   Wait until it reports connected peers. The release script probes its
   HTTP gateway on `127.0.0.1:7509`; override with `FREENET_PORT=...` if
   your node binds elsewhere.

## Cutting a release

```bash
scripts/release.sh 0.1.0
```

The script enforces:
- clean tree on `main`
- tag does not already exist (local or origin)
- production key + tools (`fdev`, `cargo-make`, `gh`, GNU tar) present
- a Freenet node reachable at `127.0.0.1:7509` (warns + asks if not)
- the signing version it will use is **greater than** the
  currently-published version (see below)
- `cargo make test` and `cargo make clippy` pass

### Signing version (monotonicity)

The on-chain web-container contract rejects any update whose version is
`<=` the currently-published one (`web/container/src/lib.rs`). The release
script derives a monotonic `u32` from the release semver —
`major*1_000_000 + minor*1_000 + patch` (so `0.1.0 → 1000`, `0.2.0 →
2000`, `1.0.0 → 1000000`) — and exports it as `WEBAPP_VERSION` for the
sign step. Minor and patch are each capped at 999.

Because the version is tied to the semver, **always bump the release
version** between releases; re-running with the same version produces the
same signing version and the network rejects the re-publish as a
non-increasing update. (The old commit-hash scheme produced random,
sometimes-decreasing versions and could silently fail to land.)

If `release.sh` finds the contract already published with a version
`>=` the one it's about to sign, it aborts in preflight and tells you to
bump.

### Unchanged snapshot

A reproducible build can leave `published-contract/` byte-identical to the
previous release (only the signature timestamp + version differ). The
script detects this, skips the empty snapshot commit, and tags HEAD
directly instead of aborting.

It then prompts 3 times before destructive steps:
1. Before publishing to the live network
2. Before committing `published-contract/`
3. Before pushing to `origin`

## Facade contract — stable bookmarkable URL (issue #45)

The web-container contract id rotates every release (its wasm + signature
change), so any URL a user bookmarked points at the *previous* release and
goes stale. The **facade** is a second contract whose id stays byte-stable
forever; its signed state points at the *current* release's web-container
id. Users bookmark the facade URL; each release flips the pointer.

```
user bookmark ──► facade contract (STABLE id) ──► current webapp (rotating id)
                  (loader HTML, postMessage nav)    (the actual UI)
```

The facade crates live **outside** the Cargo workspace
(`contracts/facade`, `contracts/facade-types`) with their own pinned
`Cargo.lock`, so dependency churn in the main workspace can't rotate the
facade wasm bytes — which would rotate its id and break every bookmark.

### One-time facade publish (per network)

Before the per-release flip can run, the facade must be published once and
its id committed. Do this once per network (sandbox, then production):

```bash
# 1. Build the facade + sign initial state pointing at the current webapp,
#    then snapshot wasm/parameters/id into published-contract/.
cargo make update-published-facade
git add published-contract/facade.wasm published-contract/facade.parameters \
        published-contract/facade-id.txt
git commit -m "chore(facade): commit production facade snapshot"

# 2. PUT the facade onto the network (ONE-TIME — never PUT again; later
#    releases UPDATE the pointer, they don't re-publish the contract).
cargo make publish-facade-test    # local sandbox
# cargo make publish-facade       # live network (drops --port, real key)
```

`published-contract/facade-id.txt` is the stable, bookmarkable id. Once it
is committed, `scripts/release.sh` performs the per-release flip
automatically.

**Canonical wasm bytes (linux/amd64).** `facade.wasm` must be byte-identical
to what CI rebuilds, or the Phase 4 gate
(`scripts/check-facade-byte-equal.sh`) fails. The facade builds
deterministically *on a given host* but macOS/arm64 and linux/amd64 emit
different codegen for the same source. The committed snapshot is canonical on
**linux/amd64 with the pinned rustc** (what CI runs). On a Linux host,
regenerate with `scripts/build-facade-snapshot-linux.sh`. On macOS, use the CI
bootstrap path: commit your local bytes, let `check-contract-wasm.yml` fail
byte-equality and upload the `facade-wasm-rebuilt-<sha>` artifact, download it,
replace `published-contract/facade.wasm`, recompute `facade-id.txt` via
`fdev get-contract-id`, and commit. (Same workflow we used for the
web-container snapshot.)

`facade.parameters` is the 32-byte production verifying key (the publisher
identity); it is **not** rebuilt by CI — only `facade.wasm` is compared. The
prod parameters + id are minted once, at the first `cargo make publish-facade`
with the production key, and stay fixed forever after.

### Per-release pointer flip (automatic)

After the webapp publish and before the commit, `scripts/release.sh` (when
`published-contract/facade-id.txt` exists):

1. Re-renders the loader with the new `current_app_id` baked in
   (`FACADE_CURRENT_APP_ID=$NEW_ID cargo make build-facade-loader`).
2. Signs a fresh facade state with the production key, version
   `WEBAPP_VERSION` (same monotonic packed semver the webapp uses).
3. Prompts, then UPDATEs the facade:
   `fdev execute update --as-state <FACADE_ID> target/facade/facade.state`.

If the facade id is not yet committed, the script warns and skips the flip;
the rest of the release still completes.

**`--as-state` is mandatory.** The facade `update_state` only matches
`UpdateData::State`; without the flag `fdev` sends `UpdateData::Delta` and
the contract rejects it as `InvalidUpdate`, so the pointer silently never
moves. `release.sh` preflight asserts the installed `fdev` supports it
(only when the facade is in play).

### Verifying the pointer flip

```bash
NEW_APP_ID=$(cat published-contract/contract-id.txt)
FACADE_ID=$(cat published-contract/facade-id.txt)

# Facade serves the loader, which bakes in the new app id.
curl -s "http://127.0.0.1:7509/v1/contract/web/${FACADE_ID}/?__sandbox=1" \
  | grep -F "${NEW_APP_ID}"          # expect the new id in CURRENT_APP_ID

# New webapp itself serves.
curl -sI "http://127.0.0.1:7509/v1/contract/web/${NEW_APP_ID}/" | head -1   # 200 OK

# Browser smoke: open the facade URL — the loader postMessages the gateway
# shell, which navigates to the new app.
echo "open http://127.0.0.1:7509/v1/contract/web/${FACADE_ID}/"
```

### Manual flip (if release.sh aborts post-publish)

If the script aborts after the webapp publish (e.g. `fdev publish` returns a
client timeout though the server-side publish landed), the webapp is live
but the pointer is stale. Resume:

```bash
NEW_APP_ID=$(cat published-contract/contract-id.txt)
curl -sI "http://127.0.0.1:7509/v1/contract/web/${NEW_APP_ID}/" | head -1   # confirm 200

FACADE_CURRENT_APP_ID="$NEW_APP_ID" cargo make sign-facade-state
fdev execute update --as-state \
    "$(cat published-contract/facade-id.txt)" \
    target/facade/facade.state
# then finish the commit/tag/push release.sh would have done.
```

### Loader template

The loader is a static HTML+JS shell (`contracts/facade-loader/src/index.html.tmpl`)
the facade serves; it bakes the current app id via the `__CURRENT_APP_ID__`
placeholder and hands off to the new webapp through the gateway shell:

```js
window.parent.postMessage({ __freenet_shell__: true, type: 'navigate', href: target }, '*');
```

postMessage (not `location.replace`) because the gateway wraps each contract
in a shell with `X-Frame-Options: DENY` inside a sandboxed iframe — a
same-window `location.replace` would try to load the new contract's shell
*inside* our iframe and the browser blocks it. Standalone (`?__sandbox=1` or
no parent frame), it falls back to `location.replace`. Always edit the
`.tmpl`, never the rendered `dist/index.html` (overwritten every build).

The `published-contract/facade.{wasm,parameters}` + `facade-id.txt` snapshot
is the source of truth for the stable id. A Linux byte-equality CI gate
guards it (issue #45 Phase 4); if it drifts, the facade Cargo.lock or
dependencies changed and the id would rotate — investigate before committing.

## Recovery

If `release.sh` fails or you abort partway:

| Stage reached            | What's safe                                  | What to clean up                                                    |
|--------------------------|----------------------------------------------|---------------------------------------------------------------------|
| Preflight or tests       | nothing changed                              | nothing                                                             |
| `publish-production` ran | webapp is live on network with new contract ID | re-run release.sh with the same version — `update-published-contract-prod` is idempotent |
| Commit created           | repo state captures the release              | if not pushed: `git reset --hard HEAD~1` to back out                 |
| Tag created              | tag is local-only until push                 | `git tag -d v0.1.0` to remove local tag                              |
| Push completed           | release is final                             | follow `RELEASING.md` §Hotfix to publish a corrected version         |

## Hotfix (republish at a new contract ID)

A published contract ID is permanent. To replace it:
1. Bump version (e.g. 0.1.0 → 0.1.1)
2. Make the fix on a branch, merge to main
3. Run `scripts/release.sh 0.1.1`

The new contract ID supersedes the old one in `published-contract/`. Users
following the published gateway URL get the new version automatically.

## Production key backup

The key in `~/.config/freenet-microblogging/web-container-keys.toml` is the
ONLY way to publish updates that this contract's clients will accept as
authentic. Treat it like a domain-name registrar password:

- Store one offline copy on encrypted media
- Store one copy in a password manager with 2FA
- Document recovery steps in your team's secrets-management playbook
- Rotate by generating a new key, publishing under a new contract ID,
  and announcing the migration to users
