import type { ReleaseParser } from "./release.js";

export type MediaTypeId = string;

/**
 * Describes one kind of media (Movie, Series, and later Music/Books) to every generic
 * subsystem (library, acquisition, naming, metadata) without any of them special-casing
 * the media type by name. Adding a new media type means writing a new descriptor + parser
 * + metadata adapter — no changes to LibraryNode, Unit, Release, acquisition orchestration,
 * jobs, or the Jellyfin-compat layer.
 */
export interface MediaTypeDescriptor {
  readonly id: MediaTypeId;
  readonly displayName: string;
  /**
   * Ordered collection levels from root to (but not including) the leaf that owns Units.
   * e.g. ["series", "season"] for TV (Series -> Season -> Episode-leaf), [] for Movie
   * (the leaf has no ancestor collection levels of its own).
   */
  readonly collectionLevels: readonly string[];
  /** Tokens valid in a rename pattern for this media type, e.g. "{SeriesTitle}", "{EpisodeNumber}". */
  readonly namingTokens: readonly string[];
  readonly releaseParser: ReleaseParser;
}

export class MediaTypeRegistry {
  private readonly descriptors = new Map<MediaTypeId, MediaTypeDescriptor>();

  register(descriptor: MediaTypeDescriptor): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`MediaType "${descriptor.id}" is already registered`);
    }
    this.descriptors.set(descriptor.id, descriptor);
  }

  get(id: MediaTypeId): MediaTypeDescriptor {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) {
      throw new Error(`Unknown MediaType "${id}"`);
    }
    return descriptor;
  }

  list(): readonly MediaTypeDescriptor[] {
    return Array.from(this.descriptors.values());
  }
}
