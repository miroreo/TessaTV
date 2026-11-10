import type { LibraryNode } from "../library-node.js";
import type { MediaFile } from "../media-file.js";
import type { Unit } from "../unit.js";
import type { UnitLocation } from "../watch-history-import.js";

/**
 * Port that `persistence` implements against Postgres/Drizzle. Everything else (library,
 * acquisition, jellyfin-compat) depends on this interface, never on the ORM directly.
 */
export interface LibraryRepository {
  getNode(id: string): Promise<LibraryNode | null>;
  listChildren(parentId: string | null): Promise<LibraryNode[]>;
  createNode(node: LibraryNode): Promise<void>;
  updateNode(node: LibraryNode): Promise<void>;
  /** Deletes exactly this node (and its external ids) — callers must reparent or delete
   * any children first; there is no cascading delete across the unconstrained parentId
   * self-reference. Fails if one of its units still has watch history: move that first
   * with `moveWatchProgress`. */
  deleteNode(id: string): Promise<void>;

  getUnit(id: string): Promise<Unit | null>;
  listUnits(libraryNodeId: string): Promise<Unit[]>;
  createUnit(unit: Unit): Promise<void>;
  updateUnit(unit: Unit): Promise<void>;
  /**
   * Moves every user's watch history from one unit to another, for when two units turn out
   * to be the same thing (an episode imported twice). Where a user has history on both, the
   * more recently updated position wins and the unit stays watched if either was.
   */
  moveWatchProgress(fromUnitId: string, toUnitId: string): Promise<void>;

  /** Every unit that has a file, with what another server's records can be matched on. */
  listUnitLocations(): Promise<UnitLocation[]>;

  getMediaFile(id: string): Promise<MediaFile | null>;
  createMediaFile(file: MediaFile): Promise<void>;
}
