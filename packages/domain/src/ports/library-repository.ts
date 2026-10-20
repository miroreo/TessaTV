import type { LibraryNode } from "../library-node.js";
import type { MediaFile } from "../media-file.js";
import type { Unit } from "../unit.js";

/**
 * Port that `persistence` implements against Postgres/Drizzle. Everything else (library,
 * acquisition, jellyfin-compat) depends on this interface, never on the ORM directly.
 */
export interface LibraryRepository {
  getNode(id: string): Promise<LibraryNode | null>;
  listChildren(parentId: string | null): Promise<LibraryNode[]>;
  createNode(node: LibraryNode): Promise<void>;
  updateNode(node: LibraryNode): Promise<void>;

  getUnit(id: string): Promise<Unit | null>;
  listUnits(libraryNodeId: string): Promise<Unit[]>;
  createUnit(unit: Unit): Promise<void>;
  updateUnit(unit: Unit): Promise<void>;

  getMediaFile(id: string): Promise<MediaFile | null>;
  createMediaFile(file: MediaFile): Promise<void>;
}
