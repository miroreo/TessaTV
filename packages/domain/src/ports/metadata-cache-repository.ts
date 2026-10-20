/**
 * Cache entry for one provider's raw lookup result, so artwork/detail lookups during
 * library browsing read from here instead of hitting the provider's API per request.
 */
export interface MetadataCacheEntry {
  readonly provider: string;
  readonly externalId: string;
  readonly payload: unknown;
  readonly fetchedAt: Date;
}

export interface MetadataCacheRepository {
  get(provider: string, externalId: string): Promise<MetadataCacheEntry | null>;
  set(entry: MetadataCacheEntry): Promise<void>;
}
