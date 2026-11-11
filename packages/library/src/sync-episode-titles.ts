import type { LibraryNode, LibraryRepository } from "@tessatv/domain";
import type { MetadataProvider } from "@tessatv/metadata";
import { listIdentifiableRoots, type MetadataProvidersByKind } from "./metadata-sweep.js";

export interface EpisodeTitleSyncError {
  readonly nodeId: string;
  readonly title: string;
  readonly message: string;
}

export interface EpisodeTitleSyncSummary {
  /** Episodes whose title was changed to the provider's. */
  readonly retitled: number;
  readonly errors: readonly EpisodeTitleSyncError[];
}

/**
 * Sets each episode's title under an identified series to the provider's name for that
 * (season, episode). Titles are otherwise guessed from filenames at import, and a rescan keeps
 * an existing episode's title (it matches on season/episode, not title), so a bad guess —
 * or a file with no title in its name — would otherwise stay wrong forever. Episodes the
 * provider doesn't name or number the same way are left alone.
 *
 * Returns how many episodes changed; a no-op for a provider that can't list episodes.
 */
export async function syncSeriesEpisodeTitles(
  repository: LibraryRepository,
  provider: MetadataProvider,
  series: LibraryNode,
): Promise<number> {
  const external = series.externalIds.find((externalId) => externalId.provider === provider.id);
  if (!external || !provider.fetchEpisodes) return 0;

  const titles = new Map<string, string>();
  for (const episode of await provider.fetchEpisodes(external.providerId)) {
    titles.set(`${episode.season}:${episode.episode}`, episode.title);
  }

  let retitled = 0;
  for (const season of await repository.listChildren(series.id)) {
    for (const node of await repository.listChildren(season.id)) {
      let changed = false;
      for (const unit of await repository.listUnits(node.id)) {
        const [seasonNumber, episodeNumber] = unit.sequence.path;
        const title = titles.get(`${seasonNumber}:${episodeNumber}`);
        if (!title) continue;
        if (unit.title !== title) await repository.updateUnit({ ...unit, title, updatedAt: new Date() });
        if (node.title !== title) {
          await repository.updateNode({ ...node, title, sortTitle: title.toLowerCase(), updatedAt: new Date() });
        }
        if (unit.title !== title || node.title !== title) changed = true;
      }
      if (changed) retitled++;
    }
  }
  return retitled;
}

/** `syncSeriesEpisodeTitles` for every identified series; one series failing (say, a network
 * blip) is recorded and doesn't stop the rest. */
export async function syncEpisodeTitles(
  repository: LibraryRepository,
  providers: MetadataProvidersByKind,
): Promise<EpisodeTitleSyncSummary> {
  const { roots } = await listIdentifiableRoots(repository, providers);
  let retitled = 0;
  const errors: EpisodeTitleSyncError[] = [];

  for (const { node, mediaKind, provider } of roots) {
    if (mediaKind !== "series") continue;
    try {
      retitled += await syncSeriesEpisodeTitles(repository, provider, node);
    } catch (error) {
      errors.push({ nodeId: node.id, title: node.title, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { retitled, errors };
}
