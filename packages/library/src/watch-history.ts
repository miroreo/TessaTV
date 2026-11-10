import {
  compareUnitSequence,
  isPlayable,
  isResumable,
  type LibraryNode,
  type LibraryRepository,
  type Unit,
  type WatchProgress,
  type WatchProgressRepository,
} from "@tessatv/domain";

export interface WatchEntry {
  readonly unit: Unit;
  /** The top-level movie or series this unit belongs to. */
  readonly root: LibraryNode;
  readonly progress: WatchProgress | null;
}

/** How far back "continue watching"/"next up" look; older activity has stopped being "current". */
const RECENT_PROGRESS_LIMIT = 200;

export async function findRoot(repository: LibraryRepository, nodeId: string): Promise<LibraryNode | null> {
  let node = await repository.getNode(nodeId);
  while (node?.parentId) node = await repository.getNode(node.parentId);
  return node;
}

/** Every unit under a node (e.g. all of a series' episodes), in sequence order. */
export async function listUnitsUnder(repository: LibraryRepository, nodeId: string): Promise<Unit[]> {
  const node = await repository.getNode(nodeId);
  if (!node) return [];
  const collect = async (current: LibraryNode): Promise<Unit[]> => {
    if (current.kind === "leaf") return repository.listUnits(current.id);
    const children = await repository.listChildren(current.id);
    return (await Promise.all(children.map(collect))).flat();
  };
  return (await collect(node)).sort((a, b) => compareUnitSequence(a.sequence, b.sequence));
}

/**
 * What "play" means for a series: resume the most recently touched episode if it's
 * unfinished, otherwise the episode after it, otherwise start from the beginning. A
 * finished final episode yields null — there's nothing next.
 */
export function pickNextUnit(units: readonly Unit[], progress: readonly WatchProgress[]): Unit | null {
  const playable = units.filter(isPlayable);
  const byUnit = new Map(progress.map((entry) => [entry.unitId, entry]));
  const latest = playable
    .map((unit) => byUnit.get(unit.id))
    .filter((entry): entry is WatchProgress => entry !== undefined)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  if (!latest) return playable[0] ?? null;
  const position = playable.findIndex((unit) => unit.id === latest.unitId);
  if (!latest.completed) return playable[position] ?? null;
  return playable[position + 1] ?? null;
}

async function resolveEntries(
  repository: LibraryRepository,
  progress: readonly WatchProgress[],
): Promise<WatchEntry[]> {
  const entries = await Promise.all(
    progress.map(async (entry) => {
      const unit = await repository.getUnit(entry.unitId);
      const root = unit ? await findRoot(repository, unit.libraryNodeId) : null;
      // A file that's gone missing drops out of "continue watching" until it's back.
      return unit && root && isPlayable(unit) ? ({ unit, root, progress: entry } satisfies WatchEntry) : null;
    }),
  );
  return entries.filter((entry) => entry !== null);
}

/** Unfinished movies and episodes, most recently watched first. */
export async function continueWatching(
  repository: LibraryRepository,
  progressRepository: WatchProgressRepository,
  userId: string,
  limit = 20,
): Promise<WatchEntry[]> {
  const recent = await progressRepository.listRecent(userId, RECENT_PROGRESS_LIMIT);
  return (await resolveEntries(repository, recent.filter(isResumable).slice(0, limit))).slice(0, limit);
}

/**
 * For each series whose most recent activity was finishing an episode, the episode after
 * it. Series being watched mid-episode are left to `continueWatching` instead, so an
 * episode never shows up in both.
 */
export async function nextUp(
  repository: LibraryRepository,
  progressRepository: WatchProgressRepository,
  userId: string,
  limit = 20,
): Promise<WatchEntry[]> {
  const recent = await resolveEntries(repository, await progressRepository.listRecent(userId, RECENT_PROGRESS_LIMIT));
  const latestPerSeries = new Map<string, WatchEntry>();
  for (const entry of recent) {
    // Movies are a single unit — there's nothing "next".
    if (entry.root.kind === "leaf" || latestPerSeries.has(entry.root.id)) continue;
    latestPerSeries.set(entry.root.id, entry);
  }

  const results: WatchEntry[] = [];
  for (const latest of latestPerSeries.values()) {
    if (results.length >= limit) break;
    if (!latest.progress?.completed) continue;
    const units = await listUnitsUnder(repository, latest.root.id);
    const progress = await progressRepository.listForUnits(userId, units.map((unit) => unit.id));
    const next = pickNextUnit(units, progress);
    if (next) results.push({ unit: next, root: latest.root, progress: progress.find((entry) => entry.unitId === next.id) ?? null });
  }
  return results;
}
