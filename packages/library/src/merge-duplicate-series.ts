import type { LibraryNode, LibraryRepository } from "@tessatv/domain";
import type { MetadataProvider } from "@tessatv/metadata";
import { findEpisodeNodeBySequence } from "./importer.js";
import { normalizeSeriesTitle } from "./parse-title-year.js";

export interface MergedSeries {
  readonly primaryNodeId: string;
  readonly mergedNodeId: string;
  readonly provider: string;
  readonly externalId: string;
}

export interface PendingSeriesMerge {
  readonly primaryNodeId: string;
  readonly duplicateNodeId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly reason: string;
}

export interface MergeDuplicateSeriesSummary {
  readonly merged: readonly MergedSeries[];
  /** Ambiguous — one or both sources had other possible matches, so this needs a human
   * to confirm via `confirmSeriesMerge` rather than being auto-merged. */
  readonly pending: readonly PendingSeriesMerge[];
}

function groupKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

/** Re-derives the title that was originally searched for (from the stable `sourceKey`,
 * since `title` gets overwritten by identify) and checks whether that search is — today —
 * still unambiguous. A single matching candidate means there was nothing else it could
 * plausibly have been; more than one means the original auto-identify was a guess among
 * options, which makes merging on top of it a compounded guess rather than a fact. */
async function isUnambiguousMatch(provider: MetadataProvider, node: LibraryNode): Promise<boolean> {
  const title = normalizeSeriesTitle(node.sourceKey);
  const candidates = await provider.search({ title, year: null, mediaKind: "series" });
  return candidates.length === 1;
}

async function mergeSeasonsInto(
  repository: LibraryRepository,
  primaryId: string,
  duplicateId: string,
): Promise<void> {
  const [duplicateSeasons, primarySeasons] = await Promise.all([
    repository.listChildren(duplicateId),
    repository.listChildren(primaryId),
  ]);
  const primarySeasonBySourceKey = new Map(primarySeasons.map((season) => [season.sourceKey, season]));

  for (const season of duplicateSeasons) {
    const matchingPrimarySeason = primarySeasonBySourceKey.get(season.sourceKey);
    if (!matchingPrimarySeason) {
      // No collision — the whole season (and its episodes) can move as-is.
      await repository.updateNode({ ...season, parentId: primaryId });
      continue;
    }

    // Same season number on both sides — reconcile episode by episode, same identity
    // rule importShows uses, then drop the now-empty duplicate season.
    const duplicateEpisodes = await repository.listChildren(season.id);
    for (const episode of duplicateEpisodes) {
      const [unit] = await repository.listUnits(episode.id);
      const sequence = unit?.sequence.path;
      const alreadyOnPrimary = sequence
        ? await findEpisodeNodeBySequence(repository, matchingPrimarySeason.id, sequence[0]!, sequence[1]!)
        : null;

      if (alreadyOnPrimary) {
        await repository.deleteNode(episode.id);
      } else {
        await repository.updateNode({ ...episode, parentId: matchingPrimarySeason.id });
      }
    }
    await repository.deleteNode(season.id);
  }

  await repository.deleteNode(duplicateId);
}

/**
 * Finds root series nodes that share an external id (the same real show, imported from
 * two different source folders — e.g. "Ink Master" and "Ink.Master" split across
 * different seasons) and merges each group. A group only auto-merges when every member's
 * original identification is still unambiguous; otherwise it's reported as `pending` for
 * a human to confirm via `confirmSeriesMerge`.
 */
export async function mergeDuplicateSeries(
  repository: LibraryRepository,
  provider: MetadataProvider | undefined,
): Promise<MergeDuplicateSeriesSummary> {
  const merged: MergedSeries[] = [];
  const pending: PendingSeriesMerge[] = [];
  if (!provider) return { merged, pending };

  const roots = await repository.listChildren(null);
  const groups = new Map<string, LibraryNode[]>();
  for (const node of roots) {
    if (node.mediaType !== "series") continue;
    for (const externalId of node.externalIds) {
      if (externalId.provider !== provider.id) continue;
      const key = groupKey(externalId.provider, externalId.providerId);
      const members = groups.get(key) ?? [];
      members.push(node);
      groups.set(key, members);
    }
  }

  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const [, externalId] = key.split(":") as [string, string];
    const [primary, ...duplicates] = [...members].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    for (const duplicate of duplicates) {
      const unambiguous = (await isUnambiguousMatch(provider, primary!)) && (await isUnambiguousMatch(provider, duplicate));

      if (unambiguous) {
        await mergeSeasonsInto(repository, primary!.id, duplicate.id);
        merged.push({ primaryNodeId: primary!.id, mergedNodeId: duplicate.id, provider: provider.id, externalId });
      } else {
        pending.push({
          primaryNodeId: primary!.id,
          duplicateNodeId: duplicate.id,
          provider: provider.id,
          externalId,
          reason: "one or both sources had other possible matches — not merged automatically",
        });
      }
    }
  }

  return { merged, pending };
}

/** Explicitly confirms a merge the automatic sweep left `pending` — bypasses the
 * ambiguity check since a human has now made the call instead of a guess. */
export async function confirmSeriesMerge(
  repository: LibraryRepository,
  primaryNodeId: string,
  duplicateNodeId: string,
): Promise<void> {
  await mergeSeasonsInto(repository, primaryNodeId, duplicateNodeId);
}
