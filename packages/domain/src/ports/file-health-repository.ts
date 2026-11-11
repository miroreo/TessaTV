import type { FileHealth } from "../file-health.js";

export interface FileHealthSummary {
  /** Every media file. */
  readonly total: number;
  /** Last checked and decoded cleanly. */
  readonly clean: number;
  /** Last check failed. */
  readonly damaged: number;
  /** Waiting for a (first or repeat) check. */
  readonly due: number;
}

export interface DamagedFile {
  readonly mediaFileId: string;
  readonly path: string;
  readonly error: string;
  readonly checkedAt: Date;
}

export interface FileHealthRepository {
  get(mediaFileId: string): Promise<FileHealth | null>;
  /** Inserts or replaces the file's result. */
  save(health: FileHealth): Promise<void>;
  /** Counts for the settings page; `staleBefore` is how old a result may be before it's due again. */
  summary(staleBefore: Date): Promise<FileHealthSummary>;
  /** Files that failed their last check, most recently checked first. */
  listDamaged(limit: number): Promise<DamagedFile[]>;
  /**
   * The next files to check: never checked first (newest imports first), then ones whose
   * size changed since the last check, then ones last checked before `staleBefore`
   * (oldest first).
   */
  listDue(limit: number, staleBefore: Date): Promise<{ id: string; path: string; sizeBytes: number }[]>;
}
