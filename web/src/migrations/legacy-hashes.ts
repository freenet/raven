/**
 * legacy-hashes.ts — per-contract code-hash registry for migrations.
 *
 * Each migratable contract carries an append-only list of the code hashes it
 * has rotated through (oldest → newest). The current hash MUST NOT appear in
 * its own legacy list — append it only AFTER bumping to a new hash. This
 * invariant is enforced by `legacy-hashes.test.ts`.
 *
 * Mirrors freenet/mail's `LEGACY_INBOX_CODE_HASHES` / `LEGACY_TOKEN_RECORD_CODE_HASHES`
 * (`ui/src/inbox.rs:66`, `ui/src/aft.rs:59`).
 *
 * See AGENTS.md → "Contract migration" for the bump recipe.
 */

export type ContractType = "posts" | "follows" | "likes";

/**
 * Sentinel emitted by `web/vite.config.ts` when a contract has not been built
 * (dev / offline / CI). A sentinel current hash means the contract is not
 * connected this session, so the migration loop skips it.
 */
export const DEV_NO_CONTRACT_HASH = "DEV_MODE_NO_CONTRACT_HASH";

// --- Append-only legacy lists. Oldest → newest. Never reorder, never delete. ---

export const LEGACY_POSTS_CODE_HASHES: readonly string[] = [];
export const LEGACY_FOLLOWS_CODE_HASHES: readonly string[] = [];
export const LEGACY_LIKES_CODE_HASHES: readonly string[] = [];

// --- Current hashes, wired from the build-time injection in vite.config.ts. ---

export const CURRENT_POSTS_CODE_HASH: string =
  typeof __MODEL_CONTRACT__ !== "undefined"
    ? __MODEL_CONTRACT__
    : DEV_NO_CONTRACT_HASH;

export const CURRENT_FOLLOWS_CODE_HASH: string =
  typeof __FOLLOWS_CONTRACT__ !== "undefined"
    ? __FOLLOWS_CONTRACT__
    : DEV_NO_CONTRACT_HASH;

export const CURRENT_LIKES_CODE_HASH: string =
  typeof __LIKES_CONTRACT__ !== "undefined"
    ? __LIKES_CONTRACT__
    : DEV_NO_CONTRACT_HASH;

export interface MigratableContract {
  readonly type: ContractType;
  readonly currentHash: string;
  readonly legacyHashes: readonly string[];
}

/** Every contract type the migration system knows how to track. */
export const MIGRATABLE_CONTRACTS: readonly MigratableContract[] = [
  {
    type: "posts",
    currentHash: CURRENT_POSTS_CODE_HASH,
    legacyHashes: LEGACY_POSTS_CODE_HASHES,
  },
  {
    type: "follows",
    currentHash: CURRENT_FOLLOWS_CODE_HASH,
    legacyHashes: LEGACY_FOLLOWS_CODE_HASHES,
  },
  {
    type: "likes",
    currentHash: CURRENT_LIKES_CODE_HASH,
    legacyHashes: LEGACY_LIKES_CODE_HASHES,
  },
];

/** A built/connected contract carries a real hash, not the dev sentinel. */
export function hasRealHash(hash: string): boolean {
  return hash.length > 0 && hash !== DEV_NO_CONTRACT_HASH;
}
