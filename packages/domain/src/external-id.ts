/**
 * A single mapping from a TessaTV entity to an ID in an external system (TMDB, TheTVDB, ...).
 * Deliberately a generic polymorphic shape instead of per-provider columns on each entity,
 * so adding a new metadata provider never requires a schema/type change here.
 */

export type ExternalIdEntityType = "library_node" | "unit";

export interface ExternalId {
  readonly provider: string;
  readonly entityType: ExternalIdEntityType;
  readonly entityId: string;
  readonly providerId: string;
}
