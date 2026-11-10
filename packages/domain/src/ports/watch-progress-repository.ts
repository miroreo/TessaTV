import type { WatchProgress } from "../watch-progress.js";

export interface WatchProgressRepository {
  get(userId: string, unitId: string): Promise<WatchProgress | null>;
  /** Inserts or overwrites the (user, unit) row. */
  save(progress: WatchProgress): Promise<void>;
  /** Most recently updated first. */
  listRecent(userId: string, limit: number): Promise<WatchProgress[]>;
  listForUnits(userId: string, unitIds: readonly string[]): Promise<WatchProgress[]>;
}
