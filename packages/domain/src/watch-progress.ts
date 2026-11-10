/**
 * How far one user has got through one Unit. Exists for "continue watching" and "next
 * up" — not a full play log, so there's one row per (user, unit), overwritten as they watch.
 */
export interface WatchProgress {
  readonly userId: string;
  readonly unitId: string;
  readonly positionSeconds: number;
  /** As reported by the player; null until it knows. */
  readonly durationSeconds: number | null;
  readonly completed: boolean;
  readonly updatedAt: Date;
}

/** Past this fraction of the runtime, credits are all that's left: count it as watched. */
export const COMPLETED_FRACTION = 0.9;
/** Below this, the user was probably just sampling — not worth offering to resume. */
export const MIN_RESUME_SECONDS = 30;

export function isCompletedPosition(positionSeconds: number, durationSeconds: number | null): boolean {
  return durationSeconds !== null && durationSeconds > 0 && positionSeconds >= durationSeconds * COMPLETED_FRACTION;
}

/** Started, not finished, and far enough in to be worth resuming. */
export function isResumable(progress: WatchProgress): boolean {
  return !progress.completed && progress.positionSeconds >= MIN_RESUME_SECONDS;
}
