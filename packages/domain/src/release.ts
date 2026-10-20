import type { MediaTypeId } from "./media-type.js";
import type { UnitSequence } from "./unit-sequence.js";

export type ReleaseProtocol = "torrent" | "usenet";

/**
 * Protocol-specific payload needed to hand a Release to a DownloadClient. Kept as a small
 * discriminated union rather than separate Release types per protocol, so everything else
 * about a Release (scoring, parsed identity, orchestration) stays protocol-agnostic.
 */
export type ReleasePayload =
  | { readonly protocol: "torrent"; readonly magnetUri: string }
  | { readonly protocol: "torrent"; readonly torrentFileUrl: string }
  | { readonly protocol: "usenet"; readonly nzbUrl: string };

export interface ParsedReleaseIdentity {
  readonly mediaType: MediaTypeId;
  readonly title: string;
  readonly sequence: UnitSequence | null;
  readonly year: number | null;
  readonly qualityHint: string | null;
}

export interface Release {
  readonly id: string;
  readonly indexerId: string;
  readonly protocol: ReleaseProtocol;
  readonly title: string;
  readonly sizeBytes: number;
  readonly publishedAt: Date;
  readonly payload: ReleasePayload;
  readonly parsedIdentity: ParsedReleaseIdentity | null;
  readonly score: number | null;
  readonly seeders: number | null;
  readonly ageHours: number | null;
}

/**
 * Parses a release's title into a candidate identity for one media type. Each MediaType
 * descriptor supplies its own parser (season/episode grammar for TV, year/edition grammar
 * for movies) — this is the one place parsing logic is legitimately media-type-specific;
 * everything downstream (scoring, grabbing, importing) consumes the generic result.
 */
export interface ReleaseParser {
  readonly mediaType: MediaTypeId;
  parse(releaseTitle: string): ParsedReleaseIdentity | null;
}
