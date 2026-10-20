import type { LibraryRepository } from "@tessatv/domain";
import { listIdentifiableRoots, type MetadataProvidersByKind } from "./metadata-sweep.js";

export interface MetadataRefreshResult {
  readonly nodeId: string;
  readonly title: string;
}

export interface MetadataRefreshError {
  readonly nodeId: string;
  readonly title: string;
  readonly message: string;
}

export interface MetadataRefreshSummary {
  readonly refreshed: readonly MetadataRefreshResult[];
  /** Root nodes not yet identified for their kind's provider — refresh has nothing to do
   * for these; auto-identify is the operation that would give them an external id. */
  readonly skipped: number;
  readonly errors: readonly MetadataRefreshError[];
  /** Root nodes whose media kind has no provider configured (e.g. TVDB_API_KEY unset). */
  readonly unavailable: number;
}

/**
 * Re-fetches details for every already-identified root node, through each node's
 * configured provider — a cheap no-op if that provider's cache entry is still within its
 * TTL, a real refetch (and cache rewrite) once it's stale. Meant to run on a schedule via
 * `packages/jobs`, so identified metadata (titles, artwork) stays current without waiting
 * for an incidental page view to trigger the refetch.
 */
export async function refreshLibraryMetadata(
  repository: LibraryRepository,
  providers: MetadataProvidersByKind,
): Promise<MetadataRefreshSummary> {
  const { roots, unavailable } = await listIdentifiableRoots(repository, providers);
  const refreshed: MetadataRefreshResult[] = [];
  const errors: MetadataRefreshError[] = [];
  let skipped = 0;

  for (const { node, mediaKind, provider } of roots) {
    const existing = node.externalIds.find((externalId) => externalId.provider === provider.id);
    if (!existing) {
      skipped++;
      continue;
    }

    try {
      const details = await provider.fetchDetails(existing.providerId, mediaKind);
      if (details) {
        refreshed.push({ nodeId: node.id, title: details.title });
      }
    } catch (error) {
      errors.push({ nodeId: node.id, title: node.title, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { refreshed, skipped, errors, unavailable };
}
