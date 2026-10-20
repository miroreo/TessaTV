import type { ExternalId } from "./external-id.js";
import type { MediaTypeId } from "./media-type.js";
import type { UnitSequence } from "./unit-sequence.js";

export type UnitAvailability = "missing" | "downloading" | "available";

/**
 * The thing that gets a file and gets played: an Episode, a Movie, a future Album track.
 * Always belongs to exactly one "leaf" LibraryNode.
 */
export interface Unit {
  readonly id: string;
  readonly libraryNodeId: string;
  readonly mediaType: MediaTypeId;
  readonly title: string;
  readonly sequence: UnitSequence;
  readonly externalIds: readonly ExternalId[];
  readonly availability: UnitAvailability;
  readonly mediaFileId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
