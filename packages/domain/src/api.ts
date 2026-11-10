import type { LibraryNode } from "./library-node.js";
import type { Unit } from "./unit.js";

/**
 * Wire shapes of TessaTV's own `/api`, shared by the server (which returns them) and the
 * web UI (which reads them), so the two can't drift apart.
 */

/** A user as it's safe to send to a client — no password hash. */
export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
}

/** What a value looks like after JSON.stringify: Dates become ISO strings. */
export type Jsonified<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Jsonified<Item>[]
    : T extends object
      ? { [Key in keyof T]: Jsonified<T[Key]> }
      : T;

/** `GET /api/auth/session` */
export interface SessionResponse {
  readonly needsSetup: boolean;
  readonly user: PublicUser | null;
}

/** `POST /api/auth/setup` and `POST /api/auth/login` */
export interface LoginResponse {
  readonly user: PublicUser;
  readonly token: string;
}

/** Every `/api` error body. */
export interface ApiErrorResponse {
  readonly error: string;
  readonly message?: string;
}

/** `GET /api/library` and `GET /api/library/:id/children` */
export interface LibraryNodesResponse {
  readonly items: readonly LibraryNode[];
}

/** `GET /api/library/:id/units` */
export interface UnitsResponse {
  readonly items: readonly Unit[];
}

/** A movie or series as the UI shows it: library data plus whatever artwork identify cached. */
export interface TitleSummary {
  readonly id: string;
  readonly title: string;
  readonly mediaType: string;
  readonly isSeries: boolean;
  readonly year: number | null;
  readonly overview: string | null;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
}

export interface UnitProgress {
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly completed: boolean;
}

export interface UnitSummary {
  readonly id: string;
  readonly title: string;
  /** From the unit's sequence path; null for movies. */
  readonly season: number | null;
  readonly episode: number | null;
  readonly playable: boolean;
  readonly progress: UnitProgress | null;
}

export interface WatchEntrySummary {
  readonly unit: UnitSummary;
  readonly title: TitleSummary;
}

/** `GET /api/browse/home` */
export interface HomeResponse {
  readonly continueWatching: readonly WatchEntrySummary[];
  readonly nextUp: readonly WatchEntrySummary[];
  readonly movies: readonly TitleSummary[];
  readonly shows: readonly TitleSummary[];
}

/** `GET /api/browse/title/:id` */
export interface TitleResponse {
  readonly title: TitleSummary;
  readonly seasons: readonly { readonly number: number; readonly episodes: readonly UnitSummary[] }[];
  readonly units: readonly UnitSummary[];
  /** What "play" starts: the unfinished episode, else the one after the last watched. */
  readonly next: UnitSummary | null;
}

export interface StreamOption {
  readonly index: number;
  readonly label: string;
  /** ISO 639 code from the file's tags, when it has one. */
  readonly language: string | null;
  readonly isDefault: boolean;
  readonly isForced?: boolean;
  /** Subtitles only: false means picking it forces a burn-in transcode. */
  readonly isTextBased?: boolean;
}

/** `GET /api/playback/:unitId` */
export interface PlaybackInfoResponse {
  readonly unit: UnitSummary;
  readonly title: TitleSummary | null;
  readonly durationSeconds: number | null;
  readonly audioStreams: readonly StreamOption[];
  readonly subtitleStreams: readonly StreamOption[];
  readonly next: UnitSummary | null;
  /** Gain that levels the measured audio stream to the broadcast target; null until measured. */
  readonly normalization: { readonly audioStreamIndex: number; readonly gainDb: number } | null;
}

/** `POST /api/playback/:unitId/start` and `.../seek` */
export interface PlaybackSessionResponse {
  readonly mode: "direct-play" | "remux" | "transcode";
  readonly url: string;
  readonly transcodeId: string | null;
  /** Where in the source the stream's own time 0 is. Subtitle cues need shifting by this. */
  readonly startTimeSeconds: number;
  /** WebVTT on the source's timeline. */
  readonly subtitleUrl: string | null;
  readonly reasons: readonly string[];
}

/** `GET /api/library/folders` */
export interface LibraryFolderSummary {
  readonly id: string;
  readonly mediaType: "movie" | "series";
  readonly path: string;
  /** Whether the server can currently list it — false for an unmounted drive, a typo, etc. */
  readonly reachable: boolean;
}

export interface LibraryScanResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly moviesAdded: number;
  readonly episodesAdded: number;
  readonly identified: number;
  /** Existing items whose file was renamed or replaced, now pointing at the new file. */
  readonly relinked: number;
  readonly markedMissing: number;
  readonly restored: number;
  /** Folders skipped this run, and why (e.g. unreachable — never treated as "everything's gone"). */
  readonly skippedFolders: readonly { readonly path: string; readonly reason: string }[];
  readonly error: string | null;
}

/** `GET /api/library/scan` and `POST /api/library/scan` */
export interface LibraryScanStatus {
  readonly running: boolean;
  readonly lastScan: LibraryScanResult | null;
}
