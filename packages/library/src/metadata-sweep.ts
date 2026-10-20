import type { LibraryNode, LibraryRepository } from "@tessatv/domain";
import type { MetadataMediaKind, MetadataProvider } from "@tessatv/metadata";
import { toMetadataMediaKind } from "@tessatv/metadata";

/** Which provider to use for each media kind, e.g. `{ movie: tmdbProvider, series: tvdbProvider }`.
 * A media kind with no entry (or `undefined`) is skipped rather than erroring. */
export type MetadataProvidersByKind = Partial<Record<MetadataMediaKind, MetadataProvider>>;

export interface IdentifiableRoot {
  readonly node: LibraryNode;
  readonly mediaKind: MetadataMediaKind;
  readonly provider: MetadataProvider;
}

export interface ListIdentifiableRootsResult {
  readonly roots: readonly IdentifiableRoot[];
  /** Root nodes whose media kind has no provider configured (e.g. TVDB_API_KEY unset). */
  readonly unavailable: number;
}

/**
 * Lists every root-level library node (movies, top-level series — `listChildren(null)`
 * only ever returns roots) alongside the provider configured for its media kind. Shared by
 * the auto-identify sweep and the periodic metadata-refresh job so both iterate the same
 * "which nodes, which provider" logic exactly once rather than duplicating it.
 */
export async function listIdentifiableRoots(
  repository: LibraryRepository,
  providers: MetadataProvidersByKind,
): Promise<ListIdentifiableRootsResult> {
  const nodes = await repository.listChildren(null);
  const roots: IdentifiableRoot[] = [];
  let unavailable = 0;

  for (const node of nodes) {
    const mediaKind = toMetadataMediaKind(node.mediaType);
    if (!mediaKind) continue;

    const provider = providers[mediaKind];
    if (!provider) {
      unavailable++;
      continue;
    }

    roots.push({ node, mediaKind, provider });
  }

  return { roots, unavailable };
}
