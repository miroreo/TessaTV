import type {
  LibraryFolder,
  LibraryFolderRepository,
  MediaAvailabilityRepository,
  MediaFileLocation,
  UnitAvailability,
} from "@tessatv/domain";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { libraryFolder, mediaFile, unit } from "./schema.js";

export class DrizzleLibraryFolderRepository implements LibraryFolderRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<LibraryFolder[]> {
    const rows = await this.db.select().from(libraryFolder).orderBy(asc(libraryFolder.mediaType), asc(libraryFolder.path));
    return rows.map((row) => ({ ...row, mediaType: row.mediaType as LibraryFolder["mediaType"] }));
  }

  async add(folder: LibraryFolder): Promise<void> {
    await this.db.insert(libraryFolder).values(folder);
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(libraryFolder).where(eq(libraryFolder.id, id));
  }
}

/** `%` and `_` are LIKE wildcards; a folder name containing them must match literally. */
function likePrefix(folder: string): string {
  const withSlash = folder.endsWith("/") ? folder : `${folder}/`;
  return `${withSlash.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export class DrizzleMediaAvailabilityRepository implements MediaAvailabilityRepository {
  constructor(private readonly db: Database) {}

  async listFilesUnder(folder: string): Promise<MediaFileLocation[]> {
    const rows = await this.db
      .select({ unitId: unit.id, path: mediaFile.path, availability: unit.availability })
      .from(mediaFile)
      .innerJoin(unit, eq(unit.mediaFileId, mediaFile.id))
      .where(sql`${mediaFile.path} like ${likePrefix(folder)}`);
    return rows.map((row) => ({ ...row, availability: row.availability as UnitAvailability }));
  }

  async setAvailability(unitIds: readonly string[], availability: UnitAvailability): Promise<void> {
    if (unitIds.length === 0) return;
    await this.db.update(unit).set({ availability, updatedAt: new Date() }).where(inArray(unit.id, [...unitIds]));
  }

  async listRootsWithPlayableUnits(): Promise<Set<string>> {
    const result = await this.db.execute<{ root: string }>(sql`
      with recursive tree as (
        select id, id as root from library_node where parent_id is null
        union all
        select child.id, tree.root from library_node child join tree on child.parent_id = tree.id
      )
      select distinct tree.root from tree
      join unit on unit.library_node_id = tree.id
      where unit.media_file_id is not null and unit.availability = 'available'
    `);
    return new Set(result.rows.map((row) => row.root));
  }
}
