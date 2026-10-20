import type { MetadataCacheEntry, MetadataCacheRepository } from "@tessatv/domain";
import { describe, expect, it, vi } from "vitest";
import { CachedMetadataProvider } from "./cached-metadata-provider.js";
import type { MetadataDetails, MetadataProvider } from "./metadata-provider.js";

class InMemoryMetadataCacheRepository implements MetadataCacheRepository {
  private readonly entries = new Map<string, MetadataCacheEntry>();

  async get(provider: string, externalId: string) {
    return this.entries.get(`${provider}:${externalId}`) ?? null;
  }
  async set(entry: MetadataCacheEntry) {
    this.entries.set(`${entry.provider}:${entry.externalId}`, entry);
  }
}

function fakeDetails(overrides: Partial<MetadataDetails> = {}): MetadataDetails {
  return {
    externalId: "603",
    title: "The Matrix",
    overview: null,
    year: 1999,
    posterUrl: null,
    backdropUrl: null,
    ...overrides,
  };
}

describe("CachedMetadataProvider", () => {
  it("calls through to the inner provider on a cache miss and caches the result", async () => {
    const inner: MetadataProvider = {
      id: "tmdb",
      search: vi.fn(),
      fetchDetails: vi.fn().mockResolvedValue(fakeDetails()),
    };
    const cache = new InMemoryMetadataCacheRepository();
    const provider = new CachedMetadataProvider(inner, cache);

    const first = await provider.fetchDetails("603", "movie");
    const second = await provider.fetchDetails("603", "movie");

    expect(first).toEqual(fakeDetails());
    expect(second).toEqual(fakeDetails());
    expect(inner.fetchDetails).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cached entry is older than the TTL", async () => {
    const inner: MetadataProvider = {
      id: "tmdb",
      search: vi.fn(),
      fetchDetails: vi.fn().mockResolvedValue(fakeDetails()),
    };
    const cache = new InMemoryMetadataCacheRepository();
    const provider = new CachedMetadataProvider(inner, cache, 10);

    await provider.fetchDetails("603", "movie");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await provider.fetchDetails("603", "movie");

    expect(inner.fetchDetails).toHaveBeenCalledTimes(2);
  });

  it("does not cache a null result (unknown id)", async () => {
    const inner: MetadataProvider = {
      id: "tmdb",
      search: vi.fn(),
      fetchDetails: vi.fn().mockResolvedValue(null),
    };
    const cache = new InMemoryMetadataCacheRepository();
    const provider = new CachedMetadataProvider(inner, cache);

    await provider.fetchDetails("999999", "movie");
    await provider.fetchDetails("999999", "movie");

    expect(inner.fetchDetails).toHaveBeenCalledTimes(2);
  });

  it("passes search calls straight through without caching", async () => {
    const inner: MetadataProvider = {
      id: "tmdb",
      search: vi.fn().mockResolvedValue([]),
      fetchDetails: vi.fn(),
    };
    const provider = new CachedMetadataProvider(inner, new InMemoryMetadataCacheRepository());

    await provider.search({ title: "The Matrix", year: 1999, mediaKind: "movie" });

    expect(inner.search).toHaveBeenCalledTimes(1);
  });
});
