/**
 * Generic ordering/identity of a Unit within its parent LibraryNode, e.g. [seasonNumber,
 * episodeNumber] for a TV episode, or [] for a Movie (which has no sub-sequence — it IS
 * the whole thing). Kept as an ordered numeric path rather than named fields like
 * `seasonNumber`/`episodeNumber` so new media types never need a schema change here.
 */
export interface UnitSequence {
  readonly path: readonly number[];
}

export function compareUnitSequence(a: UnitSequence, b: UnitSequence): number {
  const length = Math.max(a.path.length, b.path.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.path[i] ?? 0) - (b.path[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
