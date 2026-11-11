import type { ExternalId, LibraryNode, LibraryRepository, MediaFile, Unit, UnitLocation } from "@tessatv/domain";
import { eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { loadExternalIds, loadExternalIdsGrouped, replaceExternalIds } from "./external-id-store.js";
import { toDomainLibraryNode, toDomainMediaFile, toDomainUnit } from "./mappers.js";
import { externalId as externalIdTable, libraryNode as libraryNodeTable, mediaFile as mediaFileTable, unit as unitTable, watchProgress } from "./schema.js";

export class DrizzleLibraryRepository implements LibraryRepository {
  constructor(private readonly db: Database) {}

  async getNode(id: string): Promise<LibraryNode | null> {
    const [row] = await this.db.select().from(libraryNodeTable).where(eq(libraryNodeTable.id, id));
    if (!row) return null;
    const externalIds = await loadExternalIds(this.db, "library_node", id);
    return toDomainLibraryNode(row, externalIds);
  }

  async listChildren(parentId: string | null): Promise<LibraryNode[]> {
    const condition = parentId === null ? isNull(libraryNodeTable.parentId) : eq(libraryNodeTable.parentId, parentId);
    const rows = await this.db.select().from(libraryNodeTable).where(condition);
    if (rows.length === 0) return [];
    // One query for every child's ids: the importer lists the root once per movie, so a query
    // per child made a scan millions of queries long.
    const ids = await loadExternalIdsGrouped(
      this.db,
      "library_node",
      this.db.select({ id: libraryNodeTable.id }).from(libraryNodeTable).where(condition),
    );
    return rows.map((row) => toDomainLibraryNode(row, ids.get(row.id) ?? []));
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
      sourceAliases: [...(node.sourceAliases ?? [])],
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
        sourceAliases: [...(node.sourceAliases ?? [])],
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
    if (rows.length === 0) return [];
    const ids = await loadExternalIdsGrouped(
      this.db,
      "unit",
      this.db.select({ id: unitTable.id }).from(unitTable).where(eq(unitTable.libraryNodeId, libraryNodeId)),
    );
    return rows.map((row) => toDomainUnit(row, ids.get(row.id) ?? []));
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

  async listUnitLocations(): Promise<UnitLocation[]> {
    const rows = await this.db
      .select({ unitId: unitTable.id, nodeId: unitTable.libraryNodeId, mediaType: unitTable.mediaType, sequencePath: unitTable.sequencePath, path: mediaFileTable.path })
      .from(unitTable)
      .innerJoin(mediaFileTable, eq(mediaFileTable.id, unitTable.mediaFileId));
    const nodes = await this.db.select({ id: libraryNodeTable.id, parentId: libraryNodeTable.parentId }).from(libraryNodeTable);
    const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
    const ids = await this.db.select().from(externalIdTable);
    const idsByEntity = new Map<string, ExternalId[]>();
    for (const row of ids) {
      const key = `${row.entityType}:${row.entityId}`;
      idsByEntity.set(key, [
        ...(idsByEntity.get(key) ?? []),
        { provider: row.provider, entityType: row.entityType as ExternalId["entityType"], entityId: row.entityId, providerId: row.providerId },
      ]);
    }
    return rows.map((row) => {
      const externalIds = [...(idsByEntity.get(`unit:${row.unitId}`) ?? [])];
      // The unit's node, and every ancestor (a series' id reaches its episodes).
      for (let node: string | null | undefined = row.nodeId; node; node = parentOf.get(node)) {
        externalIds.push(...(idsByEntity.get(`library_node:${node}`) ?? []));
      }
      return { unitId: row.unitId, mediaType: row.mediaType, path: row.path, sequencePath: row.sequencePath, externalIds };
    });
  }

  async moveWatchProgress(fromUnitId: string, toUnitId: string): Promise<void> {
    if (fromUnitId === toUnitId) return;
    // One transaction, so the history is never in neither place.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into ${watchProgress} (user_id, unit_id, position_seconds, duration_seconds, completed, watched_at, updated_at)
        select user_id, ${toUnitId}, position_seconds, duration_seconds, completed, watched_at, updated_at
        from ${watchProgress} where unit_id = ${fromUnitId}
        on conflict (user_id, unit_id) do update set
          position_seconds = case when excluded.updated_at > ${watchProgress}.updated_at
            then excluded.position_seconds else ${watchProgress}.position_seconds end,
          duration_seconds = case when excluded.updated_at > ${watchProgress}.updated_at
            then excluded.duration_seconds else ${watchProgress}.duration_seconds end,
          completed = case when excluded.updated_at > ${watchProgress}.updated_at
            then excluded.completed else ${watchProgress}.completed end,
          watched_at = greatest(${watchProgress}.watched_at, excluded.watched_at),
          updated_at = greatest(${watchProgress}.updated_at, excluded.updated_at)
      `);
      await tx.delete(watchProgress).where(eq(watchProgress.unitId, fromUnitId));
    });
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
