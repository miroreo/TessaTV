import type { ExternalId, ExternalIdEntityType } from "@tessatv/domain";
import { eq, and } from "drizzle-orm";
import type { Database } from "./db.js";
import { externalId as externalIdTable } from "./schema.js";

/**
 * Shared load/save helpers against the one polymorphic `external_id` table — used by both
 * the LibraryNode and Unit sides of the library repository so neither duplicates this logic.
 */
export async function loadExternalIds(
  db: Database,
  entityType: ExternalIdEntityType,
  entityId: string,
): Promise<ExternalId[]> {
  const rows = await db
    .select()
    .from(externalIdTable)
    .where(and(eq(externalIdTable.entityType, entityType), eq(externalIdTable.entityId, entityId)));

  return rows.map((row) => ({
    provider: row.provider,
    entityType: row.entityType as ExternalIdEntityType,
    entityId: row.entityId,
    providerId: row.providerId,
  }));
}

export async function replaceExternalIds(
  db: Database,
  entityType: ExternalIdEntityType,
  entityId: string,
  externalIds: readonly ExternalId[],
): Promise<void> {
  await db
    .delete(externalIdTable)
    .where(and(eq(externalIdTable.entityType, entityType), eq(externalIdTable.entityId, entityId)));

  if (externalIds.length === 0) return;

  await db.insert(externalIdTable).values(
    externalIds.map((externalIdValue) => ({
      provider: externalIdValue.provider,
      entityType: externalIdValue.entityType,
      entityId: externalIdValue.entityId,
      providerId: externalIdValue.providerId,
    })),
  );
}
