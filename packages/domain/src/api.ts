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
  /** Set when single sign-on is configured and on: the login page shows this button. */
  readonly sso: { readonly buttonLabel: string } | null;
}

/** `POST /api/auth/setup` and `POST /api/auth/login` */
export interface LoginResponse {
  readonly user: PublicUser;
  readonly token: string;
}

/** `POST /api/auth/pairing`: a signed-out browser (a TV) asks for a code to be approved elsewhere. */
export interface PairingResponse {
  /** Shown on screen; typed into "Sign in a TV" on a signed-in device. */
  readonly code: string;
  /** Held by the browser and sent back to poll; never shown. */
  readonly secret: string;
  readonly expiresInSeconds: number;
}

/** `POST /api/auth/pairing/poll`; `approved` also sets the session cookie. */
export interface PairingPollResponse {
  readonly status: "pending" | "approved";
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

/** `GET /api/library/:id/metadata/candidates` */
export interface IdentifyCandidatesResponse {
  readonly provider: string;
  /** The scanned folder name the title came from, so the user can tell what they're matching. */
  readonly source: string;
  /** What was actually searched for. */
  readonly query: string;
  readonly items: readonly {
    readonly externalId: string;
    readonly title: string;
    readonly year: number | null;
    readonly overview: string | null;
    readonly posterUrl: string | null;
  }[];
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
  /** The current viewing reached the end (cleared by a rewatch). */
  readonly completed: boolean;
  /** Ever watched to the end; never cleared by a rewatch. */
  readonly watched: boolean;
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

/**
 * Subtitle files beside the video are listed among its subtitle streams with an index from here
 * up (the first is this, the next one more), so the player picks them like embedded tracks.
 */
export const EXTERNAL_SUBTITLE_INDEX_BASE = 10_000;

export interface StreamOption {
  readonly index: number;
  readonly label: string;
  /** ISO 639 code from the file's tags, when it has one. */
  readonly language: string | null;
  readonly isDefault: boolean;
  readonly isForced?: boolean;
  /** Subtitles only: a file beside the video rather than a track inside it. */
  readonly isExternal?: boolean;
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
  /**
   * How far the stream has stepped down to stay playable (0 = as planned, 3 = the most
   * compatible). The server may answer a start with a higher level than asked when the
   * requested one failed to transcode.
   */
  readonly fallbackLevel: number;
  /** Whether the stream carries a picture, so a client can tell a silent decode failure. */
  readonly hasVideo: boolean;
}

/** `GET /api/playback/:unitId/stats` (admins only): the server's side of "stats for nerds". */
export interface PlaybackStatsResponse {
  readonly file: {
    readonly path: string;
    readonly container: string;
    readonly sizeBytes: number | null;
    readonly bitRate: number | null;
    /** The background decode check; null until the file has been checked. */
    readonly health: { readonly checkedAt: string; readonly error: string | null } | null;
  };
  readonly sourceVideo: {
    readonly codec: string;
    readonly profile: string | null;
    readonly width: number;
    readonly height: number;
    readonly bitDepth: number;
    readonly frameRate: number | null;
    readonly isHdr: boolean;
  } | null;
  readonly sourceAudio: {
    readonly codec: string;
    readonly channels: number;
    readonly sampleRate: number | null;
    readonly language: string | null;
  } | null;
  /** Null for direct play, or once the transcode has been reaped. */
  readonly transcode: {
    readonly mode: "remux" | "transcode";
    readonly fallbackLevel: number;
    readonly reasons: readonly string[];
    readonly segmentContainer: string;
    readonly video: { readonly action: "copy" | "transcode"; readonly codec: string; readonly width: number | null; readonly height: number | null; readonly bitrate: number | null } | null;
    readonly audio: { readonly action: "copy" | "transcode"; readonly codec: string; readonly channels: number | null; readonly bitrate: number | null } | null;
    readonly subtitle: "sidecar" | "burn-in" | null;
    /** Where video is decoded and encoded, and on what device; null when video is copied. */
    readonly encoder: {
      readonly decode: "gpu" | "cpu";
      readonly decodeDevice: string | null;
      readonly encode: "gpu" | "cpu";
      readonly encodeDevice: string | null;
      /** `vaapi`, or `none` for software. */
      readonly accel: string;
    } | null;
    /** Why the GPU failed, when this transcode fell back to the CPU. */
    readonly hardwareError: string | null;
    readonly state: "running" | "completed" | "failed" | "stopped";
    readonly error: string | null;
    /** Encode speed relative to realtime. */
    readonly speed: number | null;
    /** Source position the transcode has reached. */
    readonly transcodedUntilSeconds: number;
    readonly startTimeSeconds: number;
  } | null;
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

/** `GET /api/settings` (admins only). Secrets are never sent back, only whether one is set. */
export interface ServerSettingsResponse {
  readonly maxStreamHeight: number | null;
  readonly oidc: {
    readonly enabled: boolean;
    readonly publicUrl: string;
    readonly issuerUrl: string;
    readonly clientId: string;
    readonly hasClientSecret: boolean;
    readonly adminGroup: string | null;
    readonly requiredGroup: string | null;
    readonly buttonLabel: string;
  } | null;
  readonly jellyfin: { readonly url: string; readonly hasApiKey: boolean } | null;
  readonly fileHealthCheck: boolean;
  readonly fileHealthFullSpeed: boolean;
}

/** `GET /api/file-health` (admins only): the background decode check, for the settings page. */
export interface FileHealthStatusResponse {
  readonly enabled: boolean;
  /** Whether the check is running unthrottled; see `ServerSettings.fileHealthFullSpeed`. */
  readonly fullSpeed: boolean;
  /** `waiting` while a transcode is running; `idle` when there's nothing left to check. */
  readonly state: "disabled" | "waiting" | "checking" | "idle";
  /** The file being decoded right now. Position and fps update about twice a second. */
  readonly current: {
    readonly path: string;
    readonly startedAt: string;
    /** Null when the file's length couldn't be read. */
    readonly durationSeconds: number | null;
    readonly positionSeconds: number;
    readonly fps: number | null;
    readonly speed: number | null;
  } | null;
  readonly total: number;
  readonly clean: number;
  readonly damaged: number;
  readonly due: number;
  readonly damagedFiles: readonly { readonly path: string; readonly error: string; readonly checkedAt: string }[];
}

/** `PATCH /api/settings`'s `jellyfin`. Omitting `apiKey` keeps the saved one. */
export interface JellyfinImportSettingsInput {
  readonly url: string;
  readonly apiKey?: string;
}

/** `POST /api/jellyfin/import` (admins only): what happened for each Jellyfin user. */
export interface JellyfinImportResponse {
  readonly users: readonly {
    readonly username: string;
    /** "imported": into their account; "held": no account yet, applied on their first sign-in. */
    readonly outcome: "imported" | "held";
    readonly matched: number;
    readonly unmatched: number;
  }[];
}

/** `PATCH /api/settings`'s `oidc`. Omitting `clientSecret` keeps the saved one. */
export interface OidcSettingsInput {
  readonly enabled: boolean;
  readonly publicUrl: string;
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly adminGroup: string | null;
  readonly requiredGroup: string | null;
  readonly buttonLabel: string;
}

/** `GET /api/users` (admins only). */
export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
  readonly hasPassword: boolean;
  readonly usesSso: boolean;
  readonly createdAt: string;
}
