import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import { eq, isNull } from "drizzle-orm";
import type { Database } from "./db.js";
import { loadExternalIds, replaceExternalIds } from "./external-id-store.js";
import { toDomainLibraryNode, toDomainMediaFile, toDomainUnit } from "./mappers.js";
import { libraryNode as libraryNodeTable, mediaFile as mediaFileTable, unit as unitTable } from "./schema.js";

export class DrizzleLibraryRepository implements LibraryRepository {
  constructor(private readonly db: Database) {}

  async getNode(id: string): Promise<LibraryNode | null> {
    const [row] = await this.db.select().from(libraryNodeTable).where(eq(libraryNodeTable.id, id));
    if (!row) return null;
    const externalIds = await loadExternalIds(this.db, "library_node", id);
    return toDomainLibraryNode(row, externalIds);
  }

  async listChildren(parentId: string | null): Promise<LibraryNode[]> {
    const rows = await this.db
      .select()
      .from(libraryNodeTable)
      .where(parentId === null ? isNull(libraryNodeTable.parentId) : eq(libraryNodeTable.parentId, parentId));

    return Promise.all(
      rows.map(async (row) => toDomainLibraryNode(row, await loadExternalIds(this.db, "library_node", row.id))),
    );
  }

  async createNode(node: LibraryNode): Promise<void> {
    await this.db.insert(libraryNodeTable).values({
      id: node.id,
      mediaType: node.mediaType,
      kind: node.kind,
      parentId: node.parentId,
      title: node.title,
      sortTitle: node.sortTitle,
      sourceKey: node.sourceKey,
      monitored: node.monitored,
      qualityProfileId: node.qualityProfileId,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    });
    await replaceExternalIds(this.db, "library_node", node.id, node.externalIds);
  }

  async updateNode(node: LibraryNode): Promise<void> {
    await this.db
      .update(libraryNodeTable)
      .set({
        parentId: node.parentId,
        title: node.title,
        sortTitle: node.sortTitle,
        monitored: node.monitored,
        qualityProfileId: node.qualityProfileId,
        updatedAt: node.updatedAt,
      })
      .where(eq(libraryNodeTable.id, node.id));
    await replaceExternalIds(this.db, "library_node", node.id, node.externalIds);
  }

  async deleteNode(id: string): Promise<void> {
    await replaceExternalIds(this.db, "library_node", id, []);
    await this.db.delete(libraryNodeTable).where(eq(libraryNodeTable.id, id));
  }

  async getUnit(id: string): Promise<Unit | null> {
    const [row] = await this.db.select().from(unitTable).where(eq(unitTable.id, id));
    if (!row) return null;
    const externalIds = await loadExternalIds(this.db, "unit", id);
    return toDomainUnit(row, externalIds);
  }

  async listUnits(libraryNodeId: string): Promise<Unit[]> {
    const rows = await this.db.select().from(unitTable).where(eq(unitTable.libraryNodeId, libraryNodeId));
    return Promise.all(rows.map(async (row) => toDomainUnit(row, await loadExternalIds(this.db, "unit", row.id))));
  }

  async createUnit(unitValue: Unit): Promise<void> {
    await this.db.insert(unitTable).values({
      id: unitValue.id,
      libraryNodeId: unitValue.libraryNodeId,
      mediaType: unitValue.mediaType,
      title: unitValue.title,
      sequencePath: [...unitValue.sequence.path],
      availability: unitValue.availability,
      mediaFileId: unitValue.mediaFileId,
      createdAt: unitValue.createdAt,
      updatedAt: unitValue.updatedAt,
    });
    await replaceExternalIds(this.db, "unit", unitValue.id, unitValue.externalIds);
  }

  async updateUnit(unitValue: Unit): Promise<void> {
    await this.db
      .update(unitTable)
      .set({
        title: unitValue.title,
        sequencePath: [...unitValue.sequence.path],
        availability: unitValue.availability,
        mediaFileId: unitValue.mediaFileId,
        updatedAt: unitValue.updatedAt,
      })
      .where(eq(unitTable.id, unitValue.id));
    await replaceExternalIds(this.db, "unit", unitValue.id, unitValue.externalIds);
  }

  async getMediaFile(id: string): Promise<MediaFile | null> {
    const [row] = await this.db.select().from(mediaFileTable).where(eq(mediaFileTable.id, id));
    return row ? toDomainMediaFile(row) : null;
  }

  async createMediaFile(file: MediaFile): Promise<void> {
    await this.db.insert(mediaFileTable).values({
      id: file.id,
      unitId: file.unitId,
      path: file.path,
      container: file.container,
      videoCodec: file.videoCodec,
      audioCodec: file.audioCodec,
      resolutionWidth: file.resolutionWidth,
      resolutionHeight: file.resolutionHeight,
      sizeBytes: file.sizeBytes,
      checksum: file.checksum,
      importedAt: file.importedAt,
    });
  }
}
