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
