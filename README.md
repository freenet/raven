# Freenet Microblogging

Freenet Microblogging App is a prototype decentralized twitter-like application that runs on top of Freenet.

## Project Structure

```
freenet-microblogging/
  contracts/          # Freenet contract source code
    posts/            # Posts contract (Rust/WASM)
  web/                # Web app (TypeScript + Webpack)
    container/        # Web contract container
    src/              # Web app source code
    dist/             # Built web assets
```

## Prerequisites

- [Rust and Cargo](https://rustup.rs/)
- [Node.js](https://nodejs.org/)
- Freenet tools:
  ```bash
  cargo install freenet
  cargo install fdev
  ```

## Build

```bash
export CARGO_TARGET_DIR=/path/to/target
make build
```

## Run

1. Start local node:
   ```bash
   make node
   ```
2. Open the web app URL printed during build (e.g. `http://127.0.0.1:7509/contract/web/<hash>/`)

## Development

The web app uses `@freenetorg/freenet-stdlib` for Freenet WebSocket API communication.

After making changes to the web app, rebuild and republish:
```bash
make webapp publish-webapp
```
