import type { ExternalId } from "./external-id.js";
import type { MediaTypeId } from "./media-type.js";

/** One user's progress on one unit as another server recorded it, ready to merge in. */
export interface ImportedWatchProgress {
  readonly unitId: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly completed: boolean;
  readonly watchedAt: Date | null;
  /** When the other server last saw activity on it: decides whether it beats what's stored. */
  readonly updatedAt: Date;
}

/** What a unit can be matched on when importing records from another server. */
export interface UnitLocation {
  readonly unitId: string;
  readonly mediaType: MediaTypeId;
  /** The media file's path as this server sees it. */
  readonly path: string;
  /** e.g. `[season, episode]` for an episode, `[]` for a movie. */
  readonly sequencePath: readonly number[];
  /** The unit's own ids plus its node's and every ancestor's (a series' TheTVDB id reaches its episodes). */
  readonly externalIds: readonly ExternalId[];
}
