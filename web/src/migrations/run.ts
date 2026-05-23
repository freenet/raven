/**
 * run.ts — startup migration loop.
 *
 * Ports the per-identity loop from freenet/mail (`ui/src/api.rs:2680-3100`),
 * collapsed to the global-contract case we have today. The Freenet SDK / DOM
 * coupling is injected via `MigrationRunnerDeps` so this stays unit-testable
 * with fakes (see `run.test.ts`).
 *
 * For each migratable contract:
 *   1. `selectMigrateFrom(prior, pending, current)` decides if state drifted.
 *   2. On drift, stamp the pending marker FIRST (crash mid-flow recovers next
 *      session), then probe each candidate hash oldest→newest until one yields
 *      state, and re-inject it under the current key.
 *   3. Stamp the current hash regardless, so drift does not refire every
 *      session even if no candidate resolved; clear the pending marker on a
 *      successful re-inject.
 *   4. First observation (nothing recorded): stamp the current hash as the
 *      baseline so the next bump is detectable.
 */

import { buildMigrationCandidates, selectMigrateFrom } from "./candidates";
import { hasRealHash, type ContractType, type MigratableContract } from "./legacy-hashes";
import type { MigrationStateStore } from "./state-store";

export interface MigrationRunnerDeps {
  readonly store: MigrationStateStore;
  /**
   * GET the contract state stored under `candidateHash` for `type`. Returns
   * the decoded state, or null if the candidate contract has no state on the
   * node (not found / timeout / decode failure).
   */
  getState(type: ContractType, candidateHash: string): Promise<unknown | null>;
  /** Re-inject migrated `state` into the current contract for `type`. */
  reinject(type: ContractType, state: unknown): Promise<void>;
  /** Optional progress sink (console + UI). */
  log?(message: string): void;
}

function shorten(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

export async function runMigrations(
  contracts: readonly MigratableContract[],
  deps: MigrationRunnerDeps,
): Promise<void> {
  for (const contract of contracts) {
    await migrateContract(contract, deps);
  }
}

async function migrateContract(
  contract: MigratableContract,
  deps: MigrationRunnerDeps,
): Promise<void> {
  const { type, currentHash, legacyHashes } = contract;
  const log = deps.log ?? (() => {});

  // Not built / not connected this session — nothing to track.
  if (!hasRealHash(currentHash)) {
    return;
  }

  const recorded = deps.store.get(type);
  const migrateFrom = selectMigrateFrom(
    recorded.recordedHash,
    recorded.pendingMigrationFrom,
    currentHash,
  );

  if (migrateFrom == null) {
    // First observation: stamp the baseline so the next bump is detectable.
    if (recorded.recordedHash == null) {
      deps.store.setRecordedHash(type, currentHash);
      log(`[migration] ${type}: first observation, baseline ${shorten(currentHash)}`);
    }
    return;
  }

  log(
    `[migration] ${type}: drift detected, migrating from ${shorten(migrateFrom)} → ${shorten(currentHash)}`,
  );

  // Stamp the pending marker FIRST so a crash mid-flow recovers next session.
  deps.store.setPendingMigrationFrom(type, migrateFrom);

  const candidates = buildMigrationCandidates(migrateFrom, legacyHashes);
  let migrated = false;
  for (const candidate of candidates) {
    if (candidate === currentHash) {
      continue; // never probe the current key as if it were old state
    }
    log(`[migration] ${type}: probing candidate ${shorten(candidate)}`);
    let state: unknown | null = null;
    try {
      state = await deps.getState(type, candidate);
    } catch (e) {
      log(`[migration] ${type}: candidate ${shorten(candidate)} GET failed: ${e}`);
    }
    if (state != null) {
      log(`[migration] ${type}: re-injecting state from ${shorten(candidate)} under ${shorten(currentHash)}`);
      await deps.reinject(type, state);
      migrated = true;
      break;
    }
  }

  // Stamp current regardless so drift does not refire each session even if no
  // candidate resolved (mirrors mail's UpdateInboxWasmHash after dispatch).
  deps.store.setRecordedHash(type, currentHash);
  if (migrated) {
    deps.store.setPendingMigrationFrom(type, null);
    log(`[migration] ${type}: migration complete`);
  } else {
    log(`[migration] ${type}: no candidate state found`);
  }
}
