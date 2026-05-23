import { describe, expect, it } from "vitest";
import {
  MIGRATABLE_CONTRACTS,
  LEGACY_FOLLOWS_CODE_HASHES,
  LEGACY_LIKES_CODE_HASHES,
  LEGACY_POSTS_CODE_HASHES,
} from "./legacy-hashes";

// Mirrors mail's `current_hash_not_in_legacy` (`ui/src/inbox.rs:1184`):
// a contract's current hash must never appear in its own legacy list —
// append it only AFTER bumping to a new hash.
describe("legacy hash invariant", () => {
  for (const contract of MIGRATABLE_CONTRACTS) {
    it(`${contract.type}: current hash is not in its legacy list`, () => {
      expect(contract.legacyHashes).not.toContain(contract.currentHash);
    });
  }

  it("legacy lists contain no duplicates", () => {
    for (const legacy of [
      LEGACY_POSTS_CODE_HASHES,
      LEGACY_FOLLOWS_CODE_HASHES,
      LEGACY_LIKES_CODE_HASHES,
    ]) {
      expect(new Set(legacy).size).toBe(legacy.length);
    }
  });
});
