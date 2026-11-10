import type { WatchProgress } from "../watch-progress.js";

export interface WatchProgressRepository {
  get(userId: string, unitId: string): Promise<WatchProgress | null>;
  /** Inserts or overwrites the (user, unit) row — except `watchedAt`, which only ever moves
   * forward: saving null or an earlier time keeps the stored one. */
  save(progress: WatchProgress): Promise<void>;
  /** Most recently updated first. */
  listRecent(userId: string, limit: number): Promise<WatchProgress[]>;
  listForUnits(userId: string, unitIds: readonly string[]): Promise<WatchProgress[]>;
}
