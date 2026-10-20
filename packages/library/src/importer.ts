import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import { randomUUID } from "node:crypto";
import type { ScannedMovie } from "./scan-movies.js";
import type { ScannedSeries } from "./scan-shows.js";

export interface ImportCounts {
  readonly created: number;
  readonly skipped: number;
}

/**
 * Matches on `sourceKey`, never `title` — `title` gets overwritten with a provider's
 * canonical name on identify, so matching re-import scans against it would silently create
 * a duplicate node every time a previously-identified item's folder is rescanned (this
 * happened in practice before `sourceKey` existed).
 */
async function findChildBySourceKey(
  repository: LibraryRepository,
  parentId: string | null,
  sourceKey: string,
): Promise<LibraryNode | null> {
  const children = await repository.listChildren(parentId);
  return children.find((child) => child.sourceKey === sourceKey) ?? null;
}

/** Exported for reuse by `merge-duplicate-series.ts`, which needs the same "does this
 * episode already exist under this season" check when reconciling two merged sources. */
export async function findEpisodeNodeBySequence(
  repository: LibraryRepository,
  seasonNodeId: string,
  season: number,
  episode: number,
): Promise<LibraryNode | null> {
  const children = await repository.listChildren(seasonNodeId);
  for (const child of children) {
    const units = await repository.listUnits(child.id);
    const unit = units[0];
    if (unit && unit.sequence.path[0] === season && unit.sequence.path[1] === episode) {
      return child;
    }
  }
  return null;
}

async function createLeafWithFile(
  repository: LibraryRepository,
  params: {
    parentId: string | null;
    mediaType: string;
    title: string;
    sourceKey: string;
    sequence: readonly number[];
    filePath: string;
    sizeBytes: number;
    container: string;
  },
): Promise<void> {
  const now = new Date();
  const nodeId = randomUUID();
  const node: LibraryNode = {
    id: nodeId,
    mediaType: params.mediaType,
    kind: "leaf",
    parentId: params.parentId,
    title: params.title,
    sortTitle: params.title.toLowerCase(),
    sourceKey: params.sourceKey,
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: now,
    updatedAt: now,
  };
  await repository.createNode(node);

  const unitId = randomUUID();
  const unit: Unit = {
    id: unitId,
    libraryNodeId: nodeId,
    mediaType: params.mediaType,
    title: params.title,
    sequence: { path: params.sequence },
    externalIds: [],
    availability: "missing",
    mediaFileId: null,
    createdAt: now,
    updatedAt: now,
  };
  await repository.createUnit(unit);

  const fileId = randomUUID();
  const file: MediaFile = {
    id: fileId,
    unitId,
    path: params.filePath,
    container: params.container,
    videoCodec: null,
    audioCodec: null,
    resolutionWidth: null,
    resolutionHeight: null,
    sizeBytes: params.sizeBytes,
    checksum: null,
    importedAt: now,
  };
  await repository.createMediaFile(file);

  await repository.updateUnit({ ...unit, mediaFileId: fileId, availability: "available", updatedAt: new Date() });
}

async function findOrCreateCollection(
  repository: LibraryRepository,
  parentId: string | null,
  mediaType: string,
  title: string,
  sourceKey: string,
): Promise<LibraryNode> {
  const existing = await findChildBySourceKey(repository, parentId, sourceKey);
  if (existing) return existing;

  const now = new Date();
  const node: LibraryNode = {
    id: randomUUID(),
    mediaType,
    kind: "collection",
    parentId,
    title,
    sortTitle: title.toLowerCase(),
    sourceKey,
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: now,
    updatedAt: now,
  };
  await repository.createNode(node);
  return node;
}

/** Idempotent: re-running against the same library skips movies already present under the root. */
export async function importMovies(
  repository: LibraryRepository,
  movies: readonly ScannedMovie[],
): Promise<ImportCounts> {
  let created = 0;
  let skipped = 0;

  for (const movie of movies) {
    const existing = await findChildBySourceKey(repository, null, movie.folderName);
    if (existing) {
      skipped++;
      continue;
    }

    await createLeafWithFile(repository, {
      parentId: null,
      mediaType: "movie",
      title: movie.title,
      sourceKey: movie.folderName,
      sequence: [],
      filePath: movie.filePath,
      sizeBytes: movie.sizeBytes,
      container: movie.container,
    });
    created++;
  }

  return { created, skipped };
}

/** Idempotent per episode: re-running matches existing episodes by (season, episode), not title. */
export async function importShows(
  repository: LibraryRepository,
  series: readonly ScannedSeries[],
): Promise<ImportCounts> {
  let created = 0;
  let skipped = 0;

  for (const show of series) {
    const seriesNode = await findOrCreateCollection(repository, null, "series", show.title, show.folderName);

    const seasonNumbers = Array.from(new Set(show.episodes.map((episode) => episode.season))).sort((a, b) => a - b);
    const seasonNodeByNumber = new Map<number, LibraryNode>();
    for (const seasonNumber of seasonNumbers) {
      seasonNodeByNumber.set(
        seasonNumber,
        await findOrCreateCollection(
          repository,
          seriesNode.id,
          "series",
          `Season ${seasonNumber}`,
          `season:${seasonNumber}`,
        ),
      );
    }

    for (const episode of show.episodes) {
      const seasonNode = seasonNodeByNumber.get(episode.season);
      if (!seasonNode) continue;

      const existing = await findEpisodeNodeBySequence(repository, seasonNode.id, episode.season, episode.episode);
      if (existing) {
        skipped++;
        continue;
      }

      await createLeafWithFile(repository, {
        parentId: seasonNode.id,
        mediaType: "series",
        title: episode.title,
        sourceKey: `episode:${episode.season}:${episode.episode}`,
        sequence: [episode.season, episode.episode],
        filePath: episode.filePath,
        sizeBytes: episode.sizeBytes,
        container: episode.container,
      });
      created++;
    }
  }

  return { created, skipped };
}
