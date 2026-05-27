import { describe, it, expect } from "vitest";
import {
  deriveInstanceId,
  deriveShardContractKey,
  hexToBytes,
} from "./shard-key";

describe("shard-key derivation", () => {
  // GROUND TRUTH pinned from the real node code path:
  //   $ fdev get-contract-id \
  //       --code target/wasm32-unknown-unknown/release/freenet_microblogging_user_shard.wasm \
  //       --parameters <32 bytes of 0x01>
  //   => 2q69AnoP5Eb61W8WesCH9NkiKnr6cDhyMhKdPgzCtxvo
  // with code hash 7iSNUfGW4WiJMuQ3ryxsD7KNPDAi31MpNoQ2nhPJRDXm.
  //
  // This vector is independent of the WASM bytes (depends only on the code
  // hash + params), so it stays valid across rebuilds as long as the node's
  // derivation algorithm — blake3(code_hash || params) — is unchanged. If this
  // test ever fails, the JS derivation has drifted from the node and every
  // GET/PUT against a shard would silently address the wrong (empty) contract.
  const CODE_HASH = "7iSNUfGW4WiJMuQ3ryxsD7KNPDAi31MpNoQ2nhPJRDXm";

  it("matches the node-derived instance id (fixed 32-byte params)", () => {
    const params = new Uint8Array(32).fill(1);
    expect(deriveInstanceId(CODE_HASH, params).base58).toBe(
      "2q69AnoP5Eb61W8WesCH9NkiKnr6cDhyMhKdPgzCtxvo",
    );
  });

  it("is deterministic for the same inputs", () => {
    const params = new Uint8Array(32).fill(7);
    const a = deriveInstanceId(CODE_HASH, params).base58;
    const b = deriveInstanceId(CODE_HASH, params).base58;
    expect(a).toBe(b);
  });

  it("differs when params differ (per-owner keys are distinct)", () => {
    const a = deriveInstanceId(CODE_HASH, new Uint8Array(32).fill(1)).base58;
    const b = deriveInstanceId(CODE_HASH, new Uint8Array(32).fill(2)).base58;
    expect(a).not.toBe(b);
  });

  it("ContractKey instance id encodes to the derived instance id", () => {
    // The key the app GET/PUT/subscribes with must address the same instance id
    // we derive — otherwise responses never match. Pin that they agree.
    const params = new Uint8Array(32).fill(1);
    const key = deriveShardContractKey(CODE_HASH, params);
    expect(key.encode()).toBe(deriveInstanceId(CODE_HASH, params).base58);
    expect(key.encode()).toBe("2q69AnoP5Eb61W8WesCH9NkiKnr6cDhyMhKdPgzCtxvo");
  });

  it("ContractKey carries the code hash bytes separately from the instance", () => {
    const key = deriveShardContractKey(CODE_HASH, new Uint8Array(32).fill(1));
    const codePart = key.codePart();
    expect(codePart).not.toBeNull();
    expect(codePart!.length).toBe(32);
  });

  // Thread shards are parameterized by the root post id, which the contract
  // reads as String::from_utf8_lossy(parameters) — so the parameter is the
  // UTF-8 bytes of the hex id STRING (64 bytes), NOT the hex-decoded bytes (32).
  // This is a DIFFERENT param encoding from the user/inbox shards (raw VK bytes),
  // and getting it wrong silently addresses an empty contract. Pin it to a
  // node-derived ground truth so the utf8-vs-decoded distinction can't regress:
  //   $ fdev get-contract-id \
  //       --code …/freenet_microblogging_thread_shard.wasm \
  //       --parameters <64 ASCII bytes of the id string>
  //   => 2r1ziXxHbV5Rdce3iEZj8MFso8qrDxYs5pVgYPTewyoW
  it("derives thread-shard key from the UTF-8 id string (node ground truth)", () => {
    const THREAD_CODE_HASH = "CEFQvEyBGkXzMxWuyi3rDrKrQ9E9VYq1dwofJPntSbnB";
    const rootPostId =
      "e1f5a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0";
    const params = new TextEncoder().encode(rootPostId); // UTF-8 string bytes
    expect(params.length).toBe(64); // 64 ASCII chars, NOT 32 hex-decoded bytes
    expect(deriveInstanceId(THREAD_CODE_HASH, params).base58).toBe(
      "2r1ziXxHbV5Rdce3iEZj8MFso8qrDxYs5pVgYPTewyoW",
    );
  });

  // Inbox shards are parameterized by the OWNER VK bytes — the SAME raw-VK-bytes
  // param encoding as the user shard (NOT the user-shard's utf8-id encoding the
  // thread shard uses). The risk this pins: a future change accidentally feeds
  // the inbox a hex STRING (3904 ASCII bytes) instead of the raw 1952 VK bytes,
  // silently addressing an empty contract — exactly the bug the thread-shard
  // vector guards against in the opposite direction.
  //
  // SELF-DERIVED, NOT NODE GROUND TRUTH. Unlike the user and thread vectors
  // above (pinned from `fdev get-contract-id` against a built .wasm), the inbox
  // shard is currently UNWIRED in this worktree: there is no built inbox .wasm,
  // no build/inbox_shard_code_hash, and no __INBOX_SHARD_CODE_HASH__ injected by
  // vite. So no real node-derived instance id exists to pin against yet. This
  // vector instead cross-checks the raw-VK-bytes ENCODING through the exact same
  // deriveInstanceId path the user shard uses, with a PLACEHOLDER code hash.
  //
  // TODO(inbox-wire): once the inbox shard is built (Makefile.toml
  // `build-inbox-shard` writes build/inbox_shard_code_hash, and vite injects
  // __INBOX_SHARD_CODE_HASH__), replace INBOX_CODE_HASH_PLACEHOLDER with the real
  // code hash and re-pin the expected base58 against:
  //   $ fdev get-contract-id \
  //       --code …/freenet_microblogging_inbox_shard.wasm \
  //       --parameters <1952 raw VK bytes>
  // so this becomes a real node ground-truth vector like the others.
  it("derives inbox-shard key from raw VK bytes (self-derived, not node truth)", () => {
    // Reuse the verified user-shard code hash purely as a stand-in: it proves the
    // raw-VK-bytes derivation path is exercised, while the value above is the only
    // node-verified one. The assertion is self-consistent (JS derivation pinned
    // against itself), not a node cross-check — see the TODO above.
    const INBOX_CODE_HASH_PLACEHOLDER =
      "7iSNUfGW4WiJMuQ3ryxsD7KNPDAi31MpNoQ2nhPJRDXm";
    // Fixed deterministic owner VK: 1952 raw bytes (NOT the 3904-char hex string).
    const ownerVk = hexToBytes("ab".repeat(1952));
    expect(ownerVk.length).toBe(1952); // raw VK bytes, NOT 3904 hex chars
    // Pinned self-derived output: blake3(code_hash_bytes || raw_vk_bytes), base58.
    expect(deriveInstanceId(INBOX_CODE_HASH_PLACEHOLDER, ownerVk).base58).toBe(
      "76Afq1mAEsiEQRQxNckj9PuAgc3Z9e2uPfXrdCz6JYNB",
    );
  });

  it("rejects a code hash that does not decode to 32 bytes", () => {
    expect(() => deriveInstanceId("abc", new Uint8Array(0))).toThrow(
      /32 bytes/,
    );
  });

  describe("hexToBytes", () => {
    it("round-trips a known hex string", () => {
      const b = hexToBytes("0a0b0c");
      expect(Array.from(b)).toEqual([10, 11, 12]);
    });

    it("decodes a full ML-DSA-65 VK length (1952 bytes from 3904 hex chars)", () => {
      const hex = "ab".repeat(1952);
      expect(hexToBytes(hex).length).toBe(1952);
    });

    it("rejects odd-length hex", () => {
      expect(() => hexToBytes("abc")).toThrow(/odd length/);
    });

    it("rejects invalid hex digits", () => {
      expect(() => hexToBytes("zz")).toThrow(/invalid hex/);
    });
  });
});
