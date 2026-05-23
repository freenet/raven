/**
 * candidates.ts — pure, node-free migration helpers.
 *
 * Ported directly from freenet/mail `ui/src/inbox.rs`
 * (`build_migration_candidates` at :78, `select_migrate_from` at :107).
 * Kept free of any Freenet SDK / DOM coupling so the precedence rules and
 * chain-build logic stay unit-testable without a node round-trip.
 */

/**
 * Build the ordered list of code hashes to probe when migrating away from
 * `priorHash`. Starts with `priorHash`, then every legacy entry that follows
 * it (oldest → newest). If `priorHash` is not in `legacy`, walks the whole
 * list. Never emits a duplicate of `priorHash`.
 */
export function buildMigrationCandidates(
  priorHash: string,
  legacy: readonly string[],
): string[] {
  const out: string[] = [priorHash];
  const idx = legacy.indexOf(priorHash);
  const startIdx = idx === -1 ? 0 : idx + 1;
  for (const h of legacy.slice(startIdx)) {
    if (h !== priorHash) {
      out.push(h);
    }
  }
  return out;
}

/**
 * Decide which prior hash (if any) to migrate state from.
 *
 * Precedence (mirrors mail's `select_migrate_from`):
 *   - `prior == current`        → None (already on the current version)
 *   - a `pending` marker exists → migrate from it (crash-recovery retry)
 *   - a `prior` hash exists     → migrate from it (drift just detected)
 *   - nothing recorded          → None (first observation)
 */
export function selectMigrateFrom(
  prior: string | null | undefined,
  pending: string | null | undefined,
  current: string,
): string | null {
  if (prior != null && prior === current) {
    return null;
  }
  if (pending != null) {
    return pending;
  }
  if (prior != null) {
    return prior;
  }
  return null;
}
