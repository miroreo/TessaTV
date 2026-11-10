import {
  isPlayable,
  type LibraryNode,
  MetadataCacheRepository,
  type TitleSummary,
  type Unit,
  type UnitSummary,
  type WatchEntrySummary,
  type WatchProgress,
} from "@tessatv/domain";
import type { WatchEntry } from "@tessatv/library";
import { toMetadataMediaKind, type MetadataDetails } from "@tessatv/metadata";

/**
 * Reads artwork straight from the metadata cache rather than through a provider, so browsing
 * never triggers an outbound API call. Unidentified (or never-fetched) titles just have none.
 */
export class Catalog {
  constructor(private readonly metadataCache: MetadataCacheRepository | null) {}

  async title(node: LibraryNode): Promise<TitleSummary> {
    const details = await this.details(node);
    return {
      id: node.id,
      title: node.title,
      mediaType: node.mediaType,
      isSeries: node.kind === "collection",
      year: details?.year ?? null,
      overview: details?.overview ?? null,
      posterUrl: details?.posterUrl ?? null,
      backdropUrl: details?.backdropUrl ?? null,
    };
  }

  titles(nodes: readonly LibraryNode[]): Promise<TitleSummary[]> {
    return Promise.all(nodes.map((node) => this.title(node)));
  }

  async entries(entries: readonly WatchEntry[]): Promise<WatchEntrySummary[]> {
    return Promise.all(
      entries.map(async (entry) => ({ unit: unitSummary(entry.unit, entry.progress), title: await this.title(entry.root) })),
    );
  }

  private async details(node: LibraryNode): Promise<MetadataDetails | null> {
    const kind = toMetadataMediaKind(node.mediaType);
    if (!this.metadataCache || !kind) return null;
    for (const externalId of node.externalIds) {
      const cached = await this.metadataCache.get(externalId.provider, `${kind}:${externalId.providerId}`);
      if (cached) return cached.payload as MetadataDetails;
    }
    return null;
  }
}

export function unitSummary(unit: Unit, progress: WatchProgress | null): UnitSummary {
  const [season, episode] = unit.sequence.path;
  return {
    id: unit.id,
    title: unit.title,
    season: season ?? null,
    episode: episode ?? null,
    playable: isPlayable(unit),
    progress: progress
      ? { positionSeconds: progress.positionSeconds, durationSeconds: progress.durationSeconds, completed: progress.completed }
      : null,
  };
}
