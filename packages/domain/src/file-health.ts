/**
 * The result of decoding one media file end to end on the CPU, so a damaged file is known
 * before anyone plays it. Re-checked when the file changes size, and every so often after
 * that to catch bit rot.
 */
export interface FileHealth {
  readonly mediaFileId: string;
  readonly checkedAt: Date;
  /** The file's size when it was checked; a different size on disk means it changed. */
  readonly sizeBytes: number;
  /** What ffmpeg reported while decoding, or null when the file decoded cleanly. */
  readonly error: string | null;
}

/** How long a clean result is trusted before the file is decoded again. */
export const FILE_HEALTH_RECHECK_DAYS = 90;
