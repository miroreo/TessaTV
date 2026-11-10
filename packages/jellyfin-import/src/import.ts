import type { ImportedWatchProgress, LibraryRepository, UserRepository, WatchProgressRepository } from "@tessatv/domain";
import { UnitIndex } from "./match.js";
import type { JellyfinHistorySource, JellyfinItem } from "./source.js";

export interface ImportUserResult {
  readonly username: string;
  /** "imported": merged into their account. "held": no account yet, applied on their first sign-in. */
  readonly outcome: "imported" | "held";
  readonly matched: number;
  readonly unmatched: number;
}

export interface ImportReport {
  readonly users: readonly ImportUserResult[];
}

export interface ImportDependencies {
  readonly source: JellyfinHistorySource;
  readonly library: Pick<LibraryRepository, "listUnitLocations">;
  readonly users: Pick<UserRepository, "getUserByUsername">;
  readonly progress: Pick<WatchProgressRepository, "importHistory" | "holdHistory">;
  readonly now?: () => Date;
}

/** A Jellyfin record as TessaTV's watch progress: finished things are placed at their end. */
export function toImportedProgress(item: JellyfinItem, unitId: string, now: Date): ImportedWatchProgress {
  const at = item.lastPlayedAt ?? now;
  return {
    unitId,
    positionSeconds: item.played ? (item.runtimeSeconds ?? item.positionSeconds) : item.positionSeconds,
    durationSeconds: item.runtimeSeconds,
    completed: item.played,
    watchedAt: item.played ? at : null,
    updatedAt: at,
  };
}

/**
 * Copies every Jellyfin user's history onto the matching TessaTV user, by username. People
 * without an account yet have theirs held until they first sign in. Safe to run repeatedly:
 * the merge only takes newer records, and nothing is ever removed.
 */
export async function importWatchHistory(deps: ImportDependencies): Promise<ImportReport> {
  const now = (deps.now ?? (() => new Date()))();
  const [jellyfinUsers, series, locations] = await Promise.all([
    deps.source.listUsers(),
    deps.source.listSeries(),
    deps.library.listUnitLocations(),
  ]);
  const index = new UnitIndex(locations);
  const seriesById = new Map(series.map((entry) => [entry.id, entry]));

  const results: ImportUserResult[] = [];
  for (const user of jellyfinUsers) {
    const entries = new Map<string, ImportedWatchProgress>();
    let unmatched = 0;
    for (const item of await deps.source.listHistory(user.id)) {
      const unitId = index.match(item, seriesById);
      if (!unitId) {
        unmatched++;
        continue;
      }
      const entry = toImportedProgress(item, unitId, now);
      const earlier = entries.get(unitId);
      // Two Jellyfin items for one file (duplicates): keep the later activity, and watched if either was.
      entries.set(unitId, !earlier ? entry : merge(earlier, entry));
    }
    const account = await deps.users.getUserByUsername(user.name);
    const list = [...entries.values()];
    if (account) await deps.progress.importHistory(account.id, list);
    else if (list.length > 0) await deps.progress.holdHistory(user.name, list);
    results.push({ username: user.name, outcome: account ? "imported" : "held", matched: list.length, unmatched });
  }
  return { users: results };
}

function merge(a: ImportedWatchProgress, b: ImportedWatchProgress): ImportedWatchProgress {
  const [older, newer] = a.updatedAt <= b.updatedAt ? [a, b] : [b, a];
  const watchedAt = [a.watchedAt, b.watchedAt].filter((date): date is Date => date !== null).sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
  return { ...newer, watchedAt, completed: newer.completed || (older.completed && newer.positionSeconds === 0) };
}
