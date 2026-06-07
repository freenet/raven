import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import { ContractKey } from "@freenetorg/freenet-stdlib";
import {
  ContractKeyT,
  ContractInstanceIdT,
} from "@freenetorg/freenet-stdlib/common";

// Derive a parameterized contract's instance id exactly as the Freenet node
// does. The node computes (freenet-stdlib `ContractKey::generate_id` /
// `from_params`):
//
//   instance_id = blake3( code_hash_bytes || parameters_bytes )
//
// where code_hash_bytes is the raw 32 bytes the contract's base58 code hash
// decodes to, and parameters_bytes is the raw parameter blob with NO length
// prefix, NO domain separation, and NO separator. The 32-byte digest is the
// instance id, base58-encoded for string form.
//
// This MUST match the node byte-for-byte or GET/PUT/UPDATE address a different
// (empty) contract and silently no-op. The match is pinned by a ground-truth
// vector in shard-key.test.ts derived from `fdev get-contract-id`.

/** Raw 32 bytes a base58 contract code hash decodes to. */
function decodeCodeHash(codeHashBase58: string): Uint8Array {
  const bytes = bs58.decode(codeHashBase58);
  if (bytes.length !== 32) {
    throw new Error(
      `code hash must decode to 32 bytes, got ${bytes.length}: ${codeHashBase58}`,
    );
  }
  return bytes;
}

/** Decode a hex string (e.g. an ML-DSA-65 verifying key) to raw bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/**
 * Compute the contract instance id for a parameterized contract.
 * @param codeHashBase58 the build-stable code hash (base58, 32 bytes decoded)
 * @param parameters the raw parameter bytes (for shards: the owner VK bytes)
 * @returns the 32-byte instance id and its base58 string form
 */
export function deriveInstanceId(
  codeHashBase58: string,
  parameters: Uint8Array,
): { bytes: Uint8Array; base58: string } {
  const codeBytes = decodeCodeHash(codeHashBase58);
  const concat = new Uint8Array(codeBytes.length + parameters.length);
  concat.set(codeBytes, 0);
  concat.set(parameters, codeBytes.length);
  const id = blake3(concat); // 32-byte digest
  return { bytes: id, base58: bs58.encode(id) };
}

/**
 * Build the node ContractKey for a parameterized contract instance. The key
 * carries the derived instance id and the contract code hash separately (unlike
 * the no-parameter shortcut in freenet-api.ts where both are the same bytes).
 */
export function deriveShardContractKey(
  codeHashBase58: string,
  parameters: Uint8Array,
): ContractKey {
  const instance = deriveInstanceId(codeHashBase58, parameters);
  const codeBytes = decodeCodeHash(codeHashBase58);
  // The runtime ContractKey constructor takes two 32-byte arrays (instance id,
  // code hash) — it wraps the first in a ContractInstanceIdT itself. The
  // published .d.ts types the first arg as ContractInstanceId, so cast the raw
  // 32-byte arrays through unknown. This mirrors freenet-api.ts deriveContractKey
  // (`new ContractKey(bytes, bytes)`), which passes Uint8Array(32) the same way.
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

/**
 * Build the PACKABLE (`…T`) ContractKey for the same parameterized instance.
 *
 * `deriveShardContractKey` returns a `ContractKey` (the flatbuffer READER
 * class), which is correct for GET/UPDATE/subscribe — those requests take a
 * `ContractKey`. But a `PutRequest`'s container nests a `WasmContractV1T`, whose
 * `key` field must serialize via `.pack()`. A reader `ContractKey` has no
 * `.pack()`, so packing it throws `FlatBuffers: field 8 must be set` (field 8 =
 * the WasmContractV1 `key`). The PUT path must therefore use the `…T` builder
 * variants. This returns the matching `ContractKeyT` from the same bytes.
 */
export function deriveShardContractKeyT(
  codeHashBase58: string,
  parameters: Uint8Array,
): ContractKeyT {
  const instance = deriveInstanceId(codeHashBase58, parameters);
  const codeBytes = decodeCodeHash(codeHashBase58);
  return new ContractKeyT(
    new ContractInstanceIdT(Array.from(instance.bytes)),
    Array.from(codeBytes),
  );
}

/**
 * Like {@link deriveShardContractKeyT} but from the raw 32-byte code hash (e.g.
 * an existing reader key's `codePart()`) instead of its base58 form — for PUT
 * sites that already hold a `ContractKey` and just need the packable twin.
 */
export function shardContractKeyTFromParts(
  codeHashBytes: Uint8Array,
  parameters: Uint8Array,
): ContractKeyT {
  if (codeHashBytes.length !== 32) {
    throw new Error(
      `code hash must be 32 bytes, got ${codeHashBytes.length}`,
    );
  }
  const concat = new Uint8Array(codeHashBytes.length + parameters.length);
  concat.set(codeHashBytes, 0);
  concat.set(parameters, codeHashBytes.length);
  const instanceBytes = blake3(concat);
  return new ContractKeyT(
    new ContractInstanceIdT(Array.from(instanceBytes)),
    Array.from(codeHashBytes),
  );
}
