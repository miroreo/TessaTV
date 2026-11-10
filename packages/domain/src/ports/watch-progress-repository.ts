import type { ImportedWatchProgress } from "../watch-history-import.js";
import type { WatchProgress } from "../watch-progress.js";

export interface WatchProgressRepository {
  get(userId: string, unitId: string): Promise<WatchProgress | null>;
  /** Inserts or overwrites the (user, unit) row — except `watchedAt`, which only ever moves
   * forward: saving null or an earlier time keeps the stored one. */
  save(progress: WatchProgress): Promise<void>;
  /** Most recently updated first. */
  listRecent(userId: string, limit: number): Promise<WatchProgress[]>;
  listForUnits(userId: string, unitIds: readonly string[]): Promise<WatchProgress[]>;

  // Explicit, viewer-requested changes. Nothing else may clear "watched".

  /**
   * Marks units watched as of `at`, counting as activity (so next up moves past them). Given
   * in viewing order, later units get later timestamps, so the last one is the latest.
   */
  markWatched(userId: string, unitIds: readonly string[], at: Date): Promise<void>;
  /** Clears "watched", the finished flag and the position; when it was last watched stays as activity. */
  markUnwatched(userId: string, unitIds: readonly string[]): Promise<void>;
  /** Back to the start without changing "watched" or when it was last watched. */
  forgetPosition(userId: string, unitId: string): Promise<void>;

  // Importing history from elsewhere (a Jellyfin server). Never deletes anything.

  /**
   * Merges imported rows into a user's history: a row only replaces what's stored when it's
   * newer (`updatedAt`), and "watched" is sticky as always. Rows for unknown units are an error.
   */
  importHistory(userId: string, entries: readonly ImportedWatchProgress[]): Promise<void>;
  /** Keeps history for someone who has no account yet, by username (case-insensitive), with the same newer-wins merge. */
  holdHistory(username: string, entries: readonly ImportedWatchProgress[]): Promise<void>;
  /** Moves held history for this username into the user's own, then forgets the held rows. Returns how many moved. */
  claimHeldHistory(username: string, userId: string): Promise<number>;
}
