export type MetadataMediaKind = "movie" | "series";

/** Maps a domain `MediaTypeId` (an open-ended string) onto the kinds this package knows how
 * to look up. Shared by every caller instead of each re-implementing the same check. */
export function toMetadataMediaKind(mediaType: string): MetadataMediaKind | null {
  return mediaType === "movie" || mediaType === "series" ? mediaType : null;
}

export interface MetadataSearchQuery {
  readonly title: string;
  readonly year: number | null;
  readonly mediaKind: MetadataMediaKind;
}

export interface MetadataSearchCandidate {
  readonly externalId: string;
  readonly title: string;
  readonly year: number | null;
  readonly overview: string | null;
  readonly posterUrl: string | null;
}

export interface MetadataDetails {
  readonly externalId: string;
  readonly title: string;
  readonly overview: string | null;
  readonly year: number | null;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
}

/**
 * Identification only — TMDB today, TheTVDB or others later as drop-in adapters. Search
 * results are deliberately a list of candidates, not an auto-picked single answer: the
 * caller decides whether to auto-apply the top match or ask for confirmation.
 */
export interface MetadataProvider {
  readonly id: string;
  search(query: MetadataSearchQuery): Promise<MetadataSearchCandidate[]>;
  fetchDetails(externalId: string, mediaKind: MetadataMediaKind): Promise<MetadataDetails | null>;
}
