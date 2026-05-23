import { describe, expect, it } from "vitest";
import { buildMigrationCandidates, selectMigrateFrom } from "./candidates";

// Table tests mirror `migration_logic_tests` in freenet/mail
// `ui/src/inbox.rs:1101`.

describe("buildMigrationCandidates", () => {
  it("returns the single prior hash when legacy is empty", () => {
    expect(buildMigrationCandidates("h0", [])).toEqual(["h0"]);
  });

  it("skips entries at or before prior", () => {
    expect(buildMigrationCandidates("h1", ["h0", "h1", "h2"])).toEqual(["h1", "h2"]);
  });

  it("walks the whole list when prior is absent", () => {
    expect(buildMigrationCandidates("unknown", ["h0", "h1"])).toEqual([
      "unknown",
      "h0",
      "h1",
    ]);
  });

  it("emits no duplicate when prior is the last legacy entry", () => {
    expect(buildMigrationCandidates("h1", ["h0", "h1"])).toEqual(["h1"]);
  });
});

describe("selectMigrateFrom", () => {
  it("returns null when prior matches current (no drift)", () => {
    expect(selectMigrateFrom("cur", null, "cur")).toBeNull();
  });

  it("ignores pending when prior matches current", () => {
    expect(selectMigrateFrom("cur", "stale", "cur")).toBeNull();
  });

  it("prefers pending over prior", () => {
    expect(selectMigrateFrom("old", "older", "cur")).toBe("older");
  });

  it("falls back to prior when no pending", () => {
    expect(selectMigrateFrom("old", null, "cur")).toBe("old");
  });

  it("uses pending when prior is absent", () => {
    expect(selectMigrateFrom(null, "older", "cur")).toBe("older");
  });

  it("returns null on first observation", () => {
    expect(selectMigrateFrom(null, null, "cur")).toBeNull();
  });
});
