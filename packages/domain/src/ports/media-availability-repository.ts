import type { UnitAvailability } from "../unit.js";

export interface MediaFileLocation {
  readonly unitId: string;
  readonly path: string;
  readonly availability: UnitAvailability;
}

/**
 * Bulk queries the library scan needs, kept apart from `LibraryRepository` (one node at a
 * time) because these touch every file under a folder in one go.
 */
export interface MediaAvailabilityRepository {
  /** Every media file whose path is inside `folder`. */
  listFilesUnder(folder: string): Promise<MediaFileLocation[]>;
  setAvailability(unitIds: readonly string[], availability: UnitAvailability): Promise<void>;
  /** Deletes media files no unit points at any more (left behind when a file is replaced). */
  deleteUnlinkedMediaFiles(): Promise<number>;
  /** Root nodes (movies, series) with at least one playable unit beneath them. */
  listRootsWithPlayableUnits(): Promise<Set<string>>;
}
