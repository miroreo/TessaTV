import type { FileHealth, FileHealthSeverity } from "../file-health.js";

export interface FileHealthSummary {
  /** Every media file. */
  readonly total: number;
  /** Last checked and decoded cleanly. */
  readonly clean: number;
  /** Last check found a few errors, or only audio errors. */
  readonly minor: number;
  /** Last check failed outright or found many video errors. */
  readonly major: number;
  /** Waiting for a (first or repeat) check. */
  readonly due: number;
}

export interface FlaggedFile {
  readonly mediaFileId: string;
  readonly path: string;
  readonly error: string;
  readonly severity: Exclude<FileHealthSeverity, "clean">;
  readonly videoErrors: number;
  readonly audioErrors: number;
  readonly checkedAt: Date;
}

export interface FileHealthRepository {
  get(mediaFileId: string): Promise<FileHealth | null>;
  /** Inserts or replaces the file's result. */
  save(health: FileHealth): Promise<void>;
  /** Counts for the settings page; `staleBefore` is how old a result may be before it's due again. */
  summary(staleBefore: Date): Promise<FileHealthSummary>;
  /** Files whose last check found something, major before minor and then most recently checked first. */
  listFlagged(limit: number): Promise<FlaggedFile[]>;
  /**
   * The next files to check: never checked first (newest imports first), then ones whose
   * size changed since the last check, then ones last checked before `staleBefore`
   * (oldest first).
   */
  listDue(limit: number, staleBefore: Date): Promise<{ id: string; path: string; sizeBytes: number }[]>;
}
