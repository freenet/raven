# Freenet Microblogging – Agent Guide

## Overview

Decentralized twitter-like application built on Freenet. Uses a TypeScript web UI
with Webpack, a Rust WASM contract for post storage/validation, and the
`@freenetorg/freenet-stdlib` TypeScript SDK for WebSocket communication with
a Freenet node.

## Quick Reference

### Commands

```bash
# Build
make build                  # Full build (contracts + web + publish)
make posts                  # Build posts contract (Rust → WASM)
make webapp                 # Build web app (TypeScript → Webpack bundle)
make publish-posts          # Publish posts contract to local node
make publish-webapp         # Publish web app to local node

# Development
cd web && npm start         # Webpack dev server on :8080
cd web && npm test          # Run Jest tests
cd web && npm run build     # Webpack build only (no fdev)

# Node
make node                   # Build tools + run local Freenet node
make run-node               # Run local node (tools already installed)
make build-tool             # Install freenet + fdev via cargo
```

### Repository Structure

```
freenet-microblogging/
├── contracts/
│   └── posts/                  # Posts contract (Rust → WASM)
│       ├── src/lib.rs          # Contract implementation
│       ├── Cargo.toml
│       ├── freenet.toml        # Contract metadata
│       └── initial_state.json  # Initial contract state
├── web/                        # TypeScript web frontend
│   ├── src/
│   │   ├── index.ts            # App entry point, WebSocket API usage
│   │   └── scss/styles.scss    # Styles (Bootstrap + custom)
│   ├── dist/                   # Static HTML served by Freenet
│   │   ├── index.html
│   │   └── state.html
│   ├── container/              # Web contract container (Rust → WASM)
│   │   └── src/lib.rs
│   ├── package.json            # npm dependencies
│   ├── tsconfig.json           # TypeScript config
│   ├── webpack.config.js       # Webpack bundler config
│   ├── jest.config.ts          # Test config
│   └── freenet.toml            # Web contract metadata
├── Cargo.toml                  # Workspace root
├── Makefile                    # Build orchestration
├── CLAUDE.md                   # → points to this file
└── AGENTS.md                   # This file (single source of truth)
```

### Key Dependencies

| Dependency | Purpose |
|-----------|---------|
| `@freenetorg/freenet-stdlib` | Freenet TypeScript SDK — WebSocket API, FlatBuffers types |
| `bootstrap` | UI framework |
| `webpack` | Module bundler |
| `typescript` | Language |
| `sass` | SCSS compilation |
| `freenet` (cargo) | Freenet node binary |
| `fdev` (cargo) | Freenet developer tools (build, publish, inspect) |

### Freenet TypeScript SDK (`@freenetorg/freenet-stdlib`)

The stdlib is the primary interface between this app and the Freenet network.

**Local development setup:** The `package.json` points to a local path
(`file:../../freenet-stdlib/typescript`) for development with latest changes.
The stdlib source lives at `/Users/hsantos/workspace/projects/freenet/freenet-stdlib/typescript`.

**Key exports used by this app:**

| Type | Purpose |
|------|---------|
| `FreenetWsApi` | WebSocket client — connects to local Freenet node |
| `ContractKey` | Contract identifier (from instance ID or code hash) |
| `GetRequest` / `GetResponse` | Fetch contract state |
| `UpdateRequest` / `UpdateResponse` | Send state updates |
| `SubscribeRequest` | Subscribe to contract change notifications |
| `UpdateNotification` | Incoming state change notification |
| `UpdateData` / `DeltaUpdate` | Delta-based state update payload |
| `PutResponse` | Contract put confirmation |
| `HostError` | Error from the Freenet node |
| `DelegateResponse` | Delegate operation response |

**API pattern:**

```typescript
// 1. Define handler with callbacks
const handler = {
    onContractPut: (response: PutResponse) => { },
    onContractGet: (response: GetResponse) => { },
    onContractUpdate: (response: UpdateResponse) => { },
    onContractUpdateNotification: (notification: UpdateNotification) => { },
    onDelegateResponse: (response: DelegateResponse) => { },
    onErr: (err: HostError) => { },
    onOpen: () => { /* register UI handlers, subscribe to contracts */ },
};

// 2. Connect to Freenet node
const api = new FreenetWsApi(new URL("ws://host/contract/command"), handler);

// 3. Use api.get(), api.update(), api.subscribe() for contract operations
```

### Architecture

- **Posts Contract** (`contracts/posts/`): Rust WASM contract that stores and
  validates blog posts as JSON. Each post has author, date, title, content.
  Delta updates append new posts to the state.

- **Web Container** (`web/container/`): Minimal Rust WASM contract that serves
  the compiled web app (Webpack bundle + HTML) as a Freenet webapp.

- **Web App** (`web/src/`): TypeScript SPA bundled with Webpack. Connects to a
  local Freenet node via WebSocket using `FreenetWsApi`. Displays contract
  state, subscribes to updates, and sends delta updates for new posts.

- **Build Pipeline**: `make build` chains: compile posts contract → publish it →
  extract its code hash → inject hash into web app via Webpack DefinePlugin →
  build web app → publish web container.

### Build Flow

```
contracts/posts/src/lib.rs
    → fdev build → WASM binary
    → fdev inspect → code hash → web/model_code_hash.txt

web/src/index.ts
    → webpack (reads model_code_hash.txt via DefinePlugin)
    → dist/bundle.js
    → fdev build → web container WASM
    → fdev publish → deployed to local node
```

The `MODEL_CONTRACT` environment variable in the web app is populated at build
time from `model_code_hash.txt`, linking the UI to the specific posts contract
instance.

### Testing

```bash
cd web && npm test           # Jest unit tests
cargo test -p freenet-microblogging-posts   # Contract tests (if any)
```

### Environment Requirements

- `CARGO_TARGET_DIR` must be set (required by Makefile)
- Node.js and npm for web app
- Rust toolchain with `wasm32-unknown-unknown` target
- `freenet` and `fdev` CLI tools (`cargo install freenet fdev`)

## Conventions

- All Freenet protocol messages use FlatBuffers types from the stdlib
- Contract state is JSON-encoded, transported as `Uint8Array`
- Delta updates are JSON arrays of post objects
- WebSocket URL pattern: `ws://{host}/contract/command`
- Contract keys derived from instance ID via `ContractKey.fromInstanceId()`
