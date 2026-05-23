import { beforeEach, describe, expect, it } from "vitest";
import { LocalStorageMigrationStateStore } from "./state-store";

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("LocalStorageMigrationStateStore", () => {
  let storage: FakeStorage;
  let store: LocalStorageMigrationStateStore;

  beforeEach(() => {
    storage = new FakeStorage();
    store = new LocalStorageMigrationStateStore(storage);
  });

  it("returns empty state for an unseen contract", () => {
    expect(store.get("posts")).toEqual({
      recordedHash: null,
      pendingMigrationFrom: null,
    });
  });

  it("persists the recorded hash under a versioned key", () => {
    store.setRecordedHash("posts", "h1");
    expect(store.get("posts").recordedHash).toBe("h1");
    expect(storage.getItem("raven:migration:posts:v1")).toContain("h1");
  });

  it("preserves the pending marker when the recorded hash changes", () => {
    store.setPendingMigrationFrom("posts", "old");
    store.setRecordedHash("posts", "new");
    expect(store.get("posts")).toEqual({
      recordedHash: "new",
      pendingMigrationFrom: "old",
    });
  });

  it("clears the pending marker independently", () => {
    store.setPendingMigrationFrom("posts", "old");
    store.setPendingMigrationFrom("posts", null);
    expect(store.get("posts").pendingMigrationFrom).toBeNull();
  });

  it("keeps contract types isolated", () => {
    store.setRecordedHash("posts", "p");
    store.setRecordedHash("follows", "f");
    expect(store.get("posts").recordedHash).toBe("p");
    expect(store.get("follows").recordedHash).toBe("f");
  });

  it("falls back to in-memory when no storage is available", () => {
    const memStore = new LocalStorageMigrationStateStore(null);
    memStore.setRecordedHash("likes", "x");
    expect(memStore.get("likes").recordedHash).toBe("x");
  });
});
