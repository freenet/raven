import { describe, expect, it, vi } from "vitest";
import { runMigrations, type MigrationRunnerDeps } from "./run";
import { LocalStorageMigrationStateStore } from "./state-store";
import {
  DEV_NO_CONTRACT_HASH,
  type ContractType,
  type MigratableContract,
} from "./legacy-hashes";

function postsContract(
  currentHash: string,
  legacyHashes: readonly string[] = [],
): MigratableContract {
  return { type: "posts", currentHash, legacyHashes };
}

function deps(overrides: Partial<MigrationRunnerDeps> = {}) {
  const store = new LocalStorageMigrationStateStore(null);
  const base = {
    store,
    getState: vi.fn(
      (_type: ContractType, _hash: string): Promise<unknown | null> =>
        Promise.resolve(null),
    ),
    reinject: vi.fn(
      (_type: ContractType, _state: unknown): Promise<void> =>
        Promise.resolve(),
    ),
  };
  return { ...base, ...overrides, store };
}

describe("runMigrations", () => {
  it("stamps a baseline on first observation without probing", async () => {
    const d = deps();
    await runMigrations([postsContract("cur")], d);
    expect(d.getState).not.toHaveBeenCalled();
    expect(d.reinject).not.toHaveBeenCalled();
    expect(d.store.get("posts").recordedHash).toBe("cur");
  });

  it("does nothing when the recorded hash already matches current", async () => {
    const d = deps();
    d.store.setRecordedHash("posts", "cur");
    await runMigrations([postsContract("cur")], d);
    expect(d.getState).not.toHaveBeenCalled();
  });

  it("skips contracts that were not built this session", async () => {
    const d = deps();
    await runMigrations([postsContract(DEV_NO_CONTRACT_HASH)], d);
    expect(d.getState).not.toHaveBeenCalled();
    expect(d.store.get("posts").recordedHash).toBeNull();
  });

  it("migrates from the prior hash and clears pending on success", async () => {
    const found = { posts: [{ id: "1" }] };
    const getState = vi.fn(async () => found);
    const reinject = vi.fn(async () => {});
    const d = deps({ getState, reinject });
    d.store.setRecordedHash("posts", "old");

    await runMigrations([postsContract("cur")], d);

    expect(getState).toHaveBeenCalledWith("posts", "old");
    expect(reinject).toHaveBeenCalledWith("posts", found);
    expect(d.store.get("posts")).toEqual({
      recordedHash: "cur",
      pendingMigrationFrom: null,
    });
  });

  it("probes candidates oldest→newest until one yields state", async () => {
    const getState = vi.fn(
      (_type: ContractType, _hash: string): Promise<unknown | null> =>
        Promise.resolve(null),
    );
    getState.mockResolvedValueOnce(null); // "old"
    getState.mockResolvedValueOnce({ posts: [] }); // "h1"
    const d = deps({ getState });
    d.store.setRecordedHash("posts", "old");

    await runMigrations([postsContract("cur", ["old", "h1"])], d);

    expect(getState.mock.calls.map((c) => c[1])).toEqual(["old", "h1"]);
  });

  it("stamps current but keeps pending when no candidate resolves", async () => {
    const d = deps({ getState: vi.fn(async () => null) });
    d.store.setRecordedHash("posts", "old");

    await runMigrations([postsContract("cur")], d);

    expect(d.store.get("posts").recordedHash).toBe("cur");
    expect(d.store.get("posts").pendingMigrationFrom).toBe("old");
  });

  it("recovers from a pending marker left by a crashed session", async () => {
    const getState = vi.fn(
      (_type: ContractType, _hash: string): Promise<unknown | null> =>
        Promise.resolve({ posts: [] }),
    );
    const d = deps({ getState });
    // Crash recovery: prior still old, pending records the in-flight source.
    d.store.setRecordedHash("posts", "old");
    d.store.setPendingMigrationFrom("posts", "older");

    await runMigrations([postsContract("cur", ["older", "old"])], d);

    // pending wins over prior as the migration source.
    expect(getState.mock.calls[0][1]).toBe("older");
  });
});
