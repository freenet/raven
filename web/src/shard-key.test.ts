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
