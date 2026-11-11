import type { MetadataCacheRepository } from "@tessatv/domain";
import type {
  MetadataDetails,
  MetadataEpisode,
  MetadataMediaKind,
  MetadataProvider,
  MetadataSearchCandidate,
  MetadataSearchQuery,
} from "./metadata-provider.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Wraps any MetadataProvider so `fetchDetails` reads/writes a persisted cache instead of
 * hitting the provider's API on every request (e.g. every time a client asks for a
 * library item's artwork). Search results are deliberately NOT cached — they're one-off
 * disambiguation queries, not something browsing should ever replay.
 */
export class CachedMetadataProvider implements MetadataProvider {
  readonly id: string;
  /** Only present when the wrapped provider can list episodes. */
  readonly fetchEpisodes?: (externalId: string) => Promise<MetadataEpisode[]>;

  constructor(
    private readonly inner: MetadataProvider,
    private readonly cache: MetadataCacheRepository,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {
    this.id = inner.id;
    const fetchEpisodes = inner.fetchEpisodes?.bind(inner);
    if (fetchEpisodes) {
      this.fetchEpisodes = async (externalId) => {
        const cacheKey = `episodes:${externalId}`;
        const cached = await this.cache.get(this.id, cacheKey);
        if (cached && Date.now() - cached.fetchedAt.getTime() < this.ttlMs) return cached.payload as MetadataEpisode[];
        const episodes = await fetchEpisodes(externalId);
        await this.cache.set({ provider: this.id, externalId: cacheKey, payload: episodes, fetchedAt: new Date() });
        return episodes;
      };
    }
  }

  search(query: MetadataSearchQuery): Promise<MetadataSearchCandidate[]> {
    return this.inner.search(query);
  }

  async fetchDetails(externalId: string, mediaKind: MetadataMediaKind): Promise<MetadataDetails | null> {
    const cacheKey = `${mediaKind}:${externalId}`;
    const cached = await this.cache.get(this.id, cacheKey);
    if (cached && Date.now() - cached.fetchedAt.getTime() < this.ttlMs) {
      return cached.payload as MetadataDetails;
    }

    const details = await this.inner.fetchDetails(externalId, mediaKind);
    if (details) {
      await this.cache.set({ provider: this.id, externalId: cacheKey, payload: details, fetchedAt: new Date() });
    }
    return details;
  }
}
