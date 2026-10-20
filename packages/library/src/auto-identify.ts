import type { LibraryNode, LibraryRepository } from "@tessatv/domain";
import type { MetadataMediaKind, MetadataProvider } from "@tessatv/metadata";
import { toMetadataMediaKind } from "@tessatv/metadata";

/** Which provider to use for each media kind, e.g. `{ movie: tmdbProvider, series: tvdbProvider }`.
 * A media kind with no entry (or `undefined`) is skipped rather than erroring. */
export type MetadataProvidersByKind = Partial<Record<MetadataMediaKind, MetadataProvider>>;

export interface AutoIdentifyMatch {
  readonly nodeId: string;
  readonly previousTitle: string;
  readonly matchedTitle: string;
  readonly externalId: string;
  readonly provider: string;
}

export interface AutoIdentifyMiss {
  readonly nodeId: string;
  readonly title: string;
}

export interface AutoIdentifyError {
  readonly nodeId: string;
  readonly title: string;
  readonly message: string;
}

export interface AutoIdentifySummary {
  readonly identified: readonly AutoIdentifyMatch[];
  readonly noMatch: readonly AutoIdentifyMiss[];
  readonly errors: readonly AutoIdentifyError[];
  readonly alreadyIdentified: number;
  /** Nodes whose media kind has no provider configured (e.g. TVDB_API_KEY unset). */
  readonly unavailable: number;
}

async function identifyOne(
  repository: LibraryRepository,
  provider: MetadataProvider,
  node: LibraryNode,
  mediaKind: MetadataMediaKind,
): Promise<AutoIdentifyMatch | null> {
  const candidates = await provider.search({ title: node.title, year: null, mediaKind });
  const topMatch = candidates[0];
  if (!topMatch) return null;

  const details = await provider.fetchDetails(topMatch.externalId, mediaKind);
  if (!details) return null;

  const externalIds = [
    ...node.externalIds.filter((externalId) => externalId.provider !== provider.id),
    { provider: provider.id, entityType: "library_node" as const, entityId: node.id, providerId: topMatch.externalId },
  ];

  await repository.updateNode({
    ...node,
    title: details.title,
    sortTitle: details.title.toLowerCase(),
    externalIds,
    updatedAt: new Date(),
  });

  return {
    nodeId: node.id,
    previousTitle: node.title,
    matchedTitle: details.title,
    externalId: topMatch.externalId,
    provider: provider.id,
  };
}

/**
 * Sweeps every root-level library node (movies, top-level series — `listChildren(null)`
 * only ever returns roots) that doesn't already have an external id from its kind's
 * provider, searches by title, and auto-applies the top-ranked candidate. Movies and
 * series can use different providers (e.g. TMDB for movies, TheTVDB for TV numbering
 * accuracy) — nothing here is provider-specific, so adding a third media kind/provider
 * later needs no changes beyond a new map entry.
 *
 * A failure on one node (e.g. a transient network error calling the provider) is recorded
 * in `errors` and does not abort the rest of the sweep — losing 55 already-identified
 * items because the 56th request hit a network blip would be worse than the failure itself.
 */
export async function autoIdentifyLibrary(
  repository: LibraryRepository,
  providers: MetadataProvidersByKind,
): Promise<AutoIdentifySummary> {
  const roots = await repository.listChildren(null);
  const identified: AutoIdentifyMatch[] = [];
  const noMatch: AutoIdentifyMiss[] = [];
  const errors: AutoIdentifyError[] = [];
  let alreadyIdentified = 0;
  let unavailable = 0;

  for (const node of roots) {
    const mediaKind = toMetadataMediaKind(node.mediaType);
    if (!mediaKind) continue;

    const provider = providers[mediaKind];
    if (!provider) {
      unavailable++;
      continue;
    }

    if (node.externalIds.some((externalId) => externalId.provider === provider.id)) {
      alreadyIdentified++;
      continue;
    }

    try {
      const match = await identifyOne(repository, provider, node, mediaKind);
      if (match) {
        identified.push(match);
      } else {
        noMatch.push({ nodeId: node.id, title: node.title });
      }
    } catch (error) {
      errors.push({ nodeId: node.id, title: node.title, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { identified, noMatch, errors, alreadyIdentified, unavailable };
}
