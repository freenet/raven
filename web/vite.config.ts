/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

function readFileOrDefault(filename: string, fallback: string): string {
  const filePath = resolve(__dirname, filename);
  return existsSync(filePath) ? readFileSync(filePath, "utf-8").trim() : fallback;
}

// Build version shown in the sidebar (mirrors freenet-email's version chip).
// Source of truth is the latest git tag (releases are tagged vX.Y.Z); falls
// back to the short commit hash, then "dev". A visible version stops us
// chasing ghost bugs from a stale published-contract on one side.
function buildVersion(): string {
  const env = process.env.APP_VERSION;
  if (env) return env.startsWith("v") ? env : `v${env}`;
  try {
    return execSync("git describe --tags --always --dirty", {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [svelte()],
  define: {
    __USER_SHARD_CODE_HASH__: JSON.stringify(readFileOrDefault("user_shard_code_hash.txt", "DEV_MODE_NO_CONTRACT_HASH")),
    __THREAD_SHARD_CODE_HASH__: JSON.stringify(readFileOrDefault("thread_shard_code_hash.txt", "DEV_MODE_NO_CONTRACT_HASH")),
    __GLOBAL_INDEX_SHARD_CODE_HASH__: JSON.stringify(readFileOrDefault("global_index_shard_code_hash.txt", "DEV_MODE_NO_CONTRACT_HASH")),
    __DELEGATE_KEY__: JSON.stringify(readFileOrDefault("delegate_key.txt", "")),
    __DELEGATE_KEY_BYTES__: readFileOrDefault("delegate_key_bytes.json", "[]"),
    __DELEGATE_CODE_HASH_BYTES__: readFileOrDefault("delegate_code_hash_bytes.json", "[]"),
    __OFFLINE_MODE__: JSON.stringify(process.env.VITE_OFFLINE_MODE === "1"),
    __APP_VERSION__: JSON.stringify(buildVersion()),
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
  },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 8080,
  },
  test: {
    // Vitest scope: src/ unit tests only. The web/tests/ directory holds
    // Playwright E2E specs that import @playwright/test (not available in
    // web/node_modules); they are run by `cargo make test-ui-playwright`.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
  },
});
