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
}
