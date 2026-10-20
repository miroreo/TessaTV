import type { ExternalId } from "./external-id.js";
import type { MediaTypeId } from "./media-type.js";

/**
 * "collection" nodes only ever have child LibraryNodes (e.g. a Series, or a Season).
 * "leaf" nodes own exactly one Unit and have no children (e.g. a Movie, or an Episode).
 * This single recursive shape covers both a flat Movie and a deep Series->Season->Episode
 * tree without separate Movie/Series/Season/Episode types.
 */
export type LibraryNodeKind = "collection" | "leaf";

export interface LibraryNode {
  readonly id: string;
  readonly mediaType: MediaTypeId;
  readonly kind: LibraryNodeKind;
  readonly parentId: string | null;
  readonly title: string;
  readonly sortTitle: string;
  readonly externalIds: readonly ExternalId[];
  readonly monitored: boolean;
  readonly qualityProfileId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
