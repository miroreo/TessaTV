import type { ExternalId, LibraryNode, MediaFile, QualityDefinition, QualityProfile, Unit } from "@tessatv/domain";
import type { InferSelectModel } from "drizzle-orm";
import type { libraryNode, mediaFile, qualityDefinition, qualityProfile, unit } from "./schema.js";

export function toDomainLibraryNode(
  row: InferSelectModel<typeof libraryNode>,
  externalIds: readonly ExternalId[],
): LibraryNode {
  return {
    id: row.id,
    mediaType: row.mediaType,
    kind: row.kind as LibraryNode["kind"],
    parentId: row.parentId,
    title: row.title,
    sortTitle: row.sortTitle,
    externalIds,
    monitored: row.monitored,
    qualityProfileId: row.qualityProfileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toDomainUnit(row: InferSelectModel<typeof unit>, externalIds: readonly ExternalId[]): Unit {
  return {
    id: row.id,
    libraryNodeId: row.libraryNodeId,
    mediaType: row.mediaType,
    title: row.title,
    sequence: { path: row.sequencePath },
    externalIds,
    availability: row.availability as Unit["availability"],
    mediaFileId: row.mediaFileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toDomainMediaFile(row: InferSelectModel<typeof mediaFile>): MediaFile {
  return {
    id: row.id,
    unitId: row.unitId,
    path: row.path,
    container: row.container,
    videoCodec: row.videoCodec,
    audioCodec: row.audioCodec,
    resolutionWidth: row.resolutionWidth,
    resolutionHeight: row.resolutionHeight,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    importedAt: row.importedAt,
  };
}

export function toDomainQualityDefinition(row: InferSelectModel<typeof qualityDefinition>): QualityDefinition {
  return { id: row.id, name: row.name, rank: row.rank };
}

export function toDomainQualityProfile(row: InferSelectModel<typeof qualityProfile>): QualityProfile {
  return {
    id: row.id,
    name: row.name,
    allowedQualityIds: row.allowedQualityIds,
    cutoffQualityId: row.cutoffQualityId,
  };
}
