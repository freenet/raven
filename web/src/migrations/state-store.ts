/**
 * state-store.ts — recorded migration state, persisted per contract type.
 *
 * For the global contracts we have today (posts/follows/likes), each contract
 * type records the hash it was last observed under plus an optional pending
 * marker for crash-recovery. This mirrors the per-identity `AliasInfo` fields
 * mail keeps on its identity delegate (`inbox_wasm_hash` +
 * `pending_migration_from`).
 *
 * Everything lives behind the `MigrationStateStore` interface so the
 * per-identity path (issue #11) can swap in a delegate-backed store later
 * without touching the migration loop.
 */

import type { ContractType } from "./legacy-hashes";

export interface RecordedMigrationState {
  /** Hash this contract's state was last observed under (null = never seen). */
  readonly recordedHash: string | null;
  /** Retry marker: a prior hash a migration was started from but not finished. */
  readonly pendingMigrationFrom: string | null;
}

const EMPTY: RecordedMigrationState = {
  recordedHash: null,
  pendingMigrationFrom: null,
};

export interface MigrationStateStore {
  get(type: ContractType): RecordedMigrationState;
  setRecordedHash(type: ContractType, hash: string): void;
  setPendingMigrationFrom(type: ContractType, priorHash: string | null): void;
}

/** Versioned localStorage key, e.g. `raven:migration:posts:v1`. */
function storageKey(type: ContractType): string {
  return `raven:migration:${type}:v1`;
}

/**
 * localStorage-backed store for the global-contract era. Falls back to an
 * in-memory map when localStorage is unavailable (SSR, private mode, tests).
 */
export class LocalStorageMigrationStateStore implements MigrationStateStore {
  private readonly memory = new Map<string, RecordedMigrationState>();
  private readonly storage: Storage | null;

  constructor(storage: Storage | null = defaultStorage()) {
    this.storage = storage;
  }

  get(type: ContractType): RecordedMigrationState {
    const key = storageKey(type);
    if (this.storage) {
      const raw = this.storage.getItem(key);
      if (raw == null) return EMPTY;
      try {
        const parsed = JSON.parse(raw) as Partial<RecordedMigrationState>;
        return {
          recordedHash: parsed.recordedHash ?? null,
          pendingMigrationFrom: parsed.pendingMigrationFrom ?? null,
        };
      } catch {
        return EMPTY;
      }
    }
    return this.memory.get(key) ?? EMPTY;
  }

  setRecordedHash(type: ContractType, hash: string): void {
    const next: RecordedMigrationState = {
      ...this.get(type),
      recordedHash: hash,
    };
    this.write(type, next);
  }

  setPendingMigrationFrom(type: ContractType, priorHash: string | null): void {
    const next: RecordedMigrationState = {
      ...this.get(type),
      pendingMigrationFrom: priorHash,
    };
    this.write(type, next);
  }

  private write(type: ContractType, state: RecordedMigrationState): void {
    const key = storageKey(type);
    if (this.storage) {
      this.storage.setItem(key, JSON.stringify(state));
    } else {
      this.memory.set(key, state);
    }
  }
}

function defaultStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // Accessing localStorage can throw in sandboxed iframes.
  }
  return null;
}
