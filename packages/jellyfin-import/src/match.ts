import type { UnitLocation } from "@tessatv/domain";
import type { JellyfinItem, JellyfinSeries } from "./source.js";

/** Metadata providers both sides know, in the order to try. Jellyfin's keys are lower-cased to these. */
const PROVIDERS = ["tvdb", "tmdb", "imdb"] as const;

/**
 * TessaTV's units indexed for matching another server's records: by file path first (the
 * two servers usually see the same files, possibly under different mount points), then by
 * metadata provider ids plus season/episode numbers.
 */
export class UnitIndex {
  private readonly byPath = new Map<string, string>();
  private readonly byBasename = new Map<string, UnitLocation[]>();
  private readonly byProvider = new Map<string, UnitLocation[]>();

  constructor(locations: readonly UnitLocation[]) {
    for (const location of locations) {
      const parts = pathParts(location.path);
      this.byPath.set(parts.join("/"), location.unitId);
      const basename = parts[parts.length - 1]!;
      this.byBasename.set(basename, [...(this.byBasename.get(basename) ?? []), location]);
      for (const id of location.externalIds) {
        const key = `${id.provider}:${id.providerId}`;
        this.byProvider.set(key, [...(this.byProvider.get(key) ?? []), location]);
      }
    }
  }

  /** The unit this Jellyfin item is, or null when nothing matches unambiguously. */
  match(item: JellyfinItem, seriesById: ReadonlyMap<string, JellyfinSeries>): string | null {
    return (item.path ? this.matchPath(item.path) : null) ?? this.matchIds(item, seriesById);
  }

  private matchPath(path: string): string | null {
    const parts = pathParts(path);
    const exact = this.byPath.get(parts.join("/"));
    if (exact) return exact;
    // Same file under a different mount: the longest shared trailing path wins, if it's unique.
    const candidates = this.byBasename.get(parts[parts.length - 1]!) ?? [];
    let best: { depth: number; units: string[] } = { depth: 0, units: [] };
    for (const candidate of candidates) {
      const depth = sharedSuffix(parts, pathParts(candidate.path));
      if (depth > best.depth) best = { depth, units: [candidate.unitId] };
      else if (depth === best.depth) best.units.push(candidate.unitId);
    }
    return best.units.length === 1 ? best.units[0]! : null;
  }

  private matchIds(item: JellyfinItem, seriesById: ReadonlyMap<string, JellyfinSeries>): string | null {
    if (item.type === "Movie") {
      return unique(this.withIds(item.providerIds).filter((location) => location.sequencePath.length === 0));
    }
    const series = item.seriesId ? seriesById.get(item.seriesId) : undefined;
    if (!series || item.seasonNumber === null || item.episodeNumber === null) return null;
    const [season, episode] = [item.seasonNumber, item.episodeNumber];
    return unique(
      this.withIds(series.providerIds).filter(
        (location) => location.sequencePath.length === 2 && location.sequencePath[0] === season && location.sequencePath[1] === episode,
      ),
    );
  }

  private withIds(providerIds: Readonly<Record<string, string>>): UnitLocation[] {
    for (const provider of PROVIDERS) {
      const id = providerIds[provider];
      const found = id ? this.byProvider.get(`${provider}:${id}`) : undefined;
      if (found?.length) return found;
    }
    return [];
  }
}

function unique(locations: readonly UnitLocation[]): string | null {
  const units = new Set(locations.map((location) => location.unitId));
  return units.size === 1 ? [...units][0]! : null;
}

/** Path components, Windows or POSIX, without empty segments. */
function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** How many trailing components two paths share. */
function sharedSuffix(a: readonly string[], b: readonly string[]): number {
  let depth = 0;
  while (depth < a.length && depth < b.length && a[a.length - 1 - depth] === b[b.length - 1 - depth]) depth++;
  return depth;
}
