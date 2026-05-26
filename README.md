# Freenet Microblogging - Decentralized Social on Freenet

Freenet Microblogging is a decentralized Twitter/X-like application built on
[Freenet](https://freenet.org), designed to provide censorship-resistant social networking where
users own their data. It features a web-based interface built with TypeScript and Vite, Rust/WASM
contracts for post storage and social graph, and an Ed25519 identity delegate for cryptographic
signing.

![Screenshot of microblogging interface](docs/screenshot.png)

## Roadmap

- [x] Posts contract with 280-character limit and content-hash deduplication
- [x] Follows contract for social graph (follow/unfollow)
- [x] Likes contract for post reactions
- [x] Ed25519 identity delegate with keypair generation and signing
- [x] Web UI with feed, compose box, profile, sidebar, dark/light mode
- [x] Onboarding flow with identity creation and import
- [x] Real-time post updates via contract subscription
- [ ] Wire likes to contract (currently local-only)
- [ ] Wire follows to contract (Following tab exists but empty)
- [ ] Post search and filtering
- [ ] Media attachments
- [ ] GhostKey support for anonymous posting

## Getting Started

### Building and Running

1. Install dependencies:

   ```bash
   # Install Rust with wasm target
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add wasm32-unknown-unknown

   # Install Node.js (v18+)
   # See https://nodejs.org/en/download

   # Install Freenet tools
   cargo install freenet
   cargo install fdev

   # Install BLAKE3 hash tool (used for delegate key computation)
   cargo install b3sum
   ```

2. Clone and set up:

   ```bash
   # Clone the repository
   git clone git@github.com:freenet/freenet-microblogging.git
   cd freenet-microblogging

   # Clone freenet-stdlib as a sibling directory (required for TypeScript SDK)
   cd .. && git clone git@github.com:nicobao/freenet-stdlib.git && cd freenet-microblogging

   # Install web dependencies
   cd web && npm install && cd ..
   ```

3. Build and publish:

   ```bash
   # Set target directory (required by Makefile.toml)
   export CARGO_TARGET_DIR=$(pwd)/target

   # Full build: contracts + delegate + web app + publish all
   cargo make build
   ```

4. Run the node:

   ```bash
   cargo make run-node
   ```

5. Open the web app URL printed during publish
   (e.g. `http://127.0.0.1:7509/contract/web/<hash>/`)

### Key Development Commands

```bash
# Rebuild just the web app
cargo make build-ui publish-webapp-test

# Build the shard contracts (parameterized — instantiated per owner/thread at
# runtime by the web app, not published globally)
cargo make build-contracts

# Rebuild identity delegate
cargo make publish-identity

# Run all tests (Rust + web)
cargo make test

# Type check everything
cargo make check

# Reset node data (required when republishing contracts)
cargo make clean-node

# Vite dev server (without Freenet)
cd web && npm run dev
```

## Technical Details

### Project Structure

- [contracts/user-shard](contracts/user-shard/): per-owner shard — posts, profile, follows (owner-writes)
- [contracts/thread-shard](contracts/thread-shard/): per-root-post shard — replies, likes, quotes (anyone-writes)
- [contracts/inbox-shard](contracts/inbox-shard/): per-owner shard — notifications (anyone-writes, owner-prunes)
- [delegates/identity](delegates/identity/): ML-DSA-65 identity delegate (keygen, post/like signing)
- [web](web/): TypeScript + Vite web application

### Architecture

The system is built using:

- **Freenet Contracts**: Rust/WASM contracts with commutative merge for conflict-free replication
- **Freenet Delegates**: Client-side WASM modules for identity and cryptographic operations
- **freenet-stdlib**: TypeScript SDK for WebSocket communication with the Freenet node
- **Vite**: Fast build toolchain for the web app, served as a webapp contract
- **ML-DSA-65** (FIPS 204): post-quantum signatures for identity and all signed records
- **BLAKE3**: content-addressable post ids, contract key derivation, delegate key computation

### Contract Architecture (ADR-0001 sharding)

State is split into per-owner / per-thread **shards** instead of global contracts. Each
shard is a commutative (CRDT) Rust/WASM contract parameterized by an owner key or root
post id, so its contract key is `blake3(code_hash || parameters)` and it is instantiated
on demand by the web app (no global publish). See [docs/adr/0001-implementation-notes.md](docs/adr/0001-implementation-notes.md).

- [user-shard](contracts/user-shard/src/lib.rs): owner-writes — posts (windowed, content-addressed, ML-DSA-signed), profile (LWW), follows (per-key seq merge). Parameter: owner VK bytes.
- [thread-shard](contracts/thread-shard/src/lib.rs): anyone-writes — replies, likes, quotes; each record self-verifying. Parameter: root post id (UTF-8).
- [inbox-shard](contracts/inbox-shard/src/lib.rs): anyone-writes notifications, owner-prunes via signed ops. Parameter: owner VK bytes.

### Identity Delegate

The identity delegate runs client-side in the Freenet node and manages Ed25519 keypairs. It supports:

- **CreateIdentity**: Generate a new keypair with display name
- **GetIdentity**: Retrieve the current identity
- **SignPost**: Sign post content for authenticity
- **ExportIdentity / ImportIdentity**: Transfer identity between devices

The delegate key is computed as `BLAKE3(BLAKE3(wasm_bytes))` with empty parameters, and the code
hash as `BLAKE3(wasm_bytes)`. Both are required for the node to locate the delegate in its store.

### Privacy Model

- Posts are currently public and readable by anyone with the contract address
- Identity keys are stored locally in the node's delegate store
- Post signatures provide authenticity but not confidentiality
- Future versions may support encrypted posts and private feeds

## License

Freenet Microblogging is open-source software. See [LICENSE](LICENSE) for details.
