/**
 * What a wanted subtitle looks like to the rest of the app. Which providers exist, how they
 * are searched and how candidates are scored all live in `packages/subtitles`; this is only
 * what is persisted and shared.
 */

/** A subtitle file that sits beside a unit's video. */
export interface SubtitleFile {
  readonly id: string;
  readonly unitId: string;
  readonly mediaFileId: string;
  /** Normalized: `en`, `pt-BR`. */
  readonly language: string;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
  /** `downloaded` by us, or `sidecar-found` when the scan met one already on disk. */
  readonly source: "downloaded" | "sidecar-found";
  readonly provider: string | null;
  readonly providerId: string | null;
  readonly score: number | null;
  readonly path: string;
  /** `srt`, `ass`, ... */
  readonly format: string;
  readonly createdAt: Date;
}

/**
 * One thing a unit needs, e.g. English subtitles, or English forced subtitles. The key is
 * `language` or `language.forced`.
 */
export interface SubtitleSlot {
  readonly language: string;
  readonly forced: boolean;
}

export function subtitleSlotKey(slot: SubtitleSlot): string {
  return slot.forced ? `${slot.language}.forced` : slot.language;
}

/** What the last search for a slot found, so the sweep knows when to look again. */
export interface SubtitleSearchRecord {
  readonly unitId: string;
  readonly slotKey: string;
  /**
   * `none`: searched, nothing good enough yet. `unavailable`: every provider was failing or
   * paused, so nothing was learned. `embedded`: the video already carries a text track for it.
   */
  readonly outcome: "none" | "unavailable" | "embedded";
  readonly attempts: number;
  readonly attemptedAt: Date;
  /** Not searched again before this. */
  readonly retryAfter: Date;
}

/** A unit with a playable file that still needs a slot filled. */
export interface WantedSubtitle {
  readonly unitId: string;
  readonly mediaFileId: string;
  readonly videoPath: string;
}
