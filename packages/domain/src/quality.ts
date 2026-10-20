/**
 * Quality handling is already media-type-agnostic by nature in this domain (a "1080p"
 * ranking makes sense for a movie or an episode alike), so QualityDefinition/QualityProfile
 * carry no mediaType field and are reused verbatim across media types.
 */
export interface QualityDefinition {
  readonly id: string;
  readonly name: string;
  /** Higher rank = better quality. Used to order candidates within a profile. */
  readonly rank: number;
}

export interface QualityProfile {
  readonly id: string;
  readonly name: string;
  /** Quality definition ids this profile will accept, any order. */
  readonly allowedQualityIds: readonly string[];
  /** Once a Unit has a file at or above this quality's rank, stop upgrading it. */
  readonly cutoffQualityId: string;
}
