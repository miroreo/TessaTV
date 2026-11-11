import type { FileHealth } from "../file-health.js";

export interface FileHealthRepository {
  get(mediaFileId: string): Promise<FileHealth | null>;
  /** Inserts or replaces the file's result. */
  save(health: FileHealth): Promise<void>;
  /**
   * The next files to check: never checked first (newest imports first), then ones whose
   * size changed since the last check, then ones last checked before `staleBefore`
   * (oldest first).
   */
  listDue(limit: number, staleBefore: Date): Promise<{ id: string; path: string; sizeBytes: number }[]>;
}
