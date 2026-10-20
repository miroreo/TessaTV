import type { LibraryNode, LibraryRepository, MediaFile } from "@tessatv/domain";
import type { MetadataProvider } from "@tessatv/metadata";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";

function fakeNode(overrides: Partial<LibraryNode> = {}): LibraryNode {
  return {
    id: "node-1",
    mediaType: "movie",
    kind: "leaf",
    parentId: null,
    title: "Some Movie",
    sortTitle: "some movie",
    sourceKey: "Some Movie (1999)",
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

class InMemoryLibraryRepository implements LibraryRepository {
  constructor(private readonly nodes: LibraryNode[] = []) {}

  async getNode(id: string) {
    return this.nodes.find((node) => node.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((node) => node.parentId === parentId);
  }
  async createNode(node: LibraryNode) {
    this.nodes.push(node);
  }
  async updateNode(node: LibraryNode) {
    const index = this.nodes.findIndex((existing) => existing.id === node.id);
    if (index >= 0) this.nodes[index] = node;
  }
  async deleteNode(id: string) {
    const index = this.nodes.findIndex((existing) => existing.id === id);
    if (index >= 0) this.nodes.splice(index, 1);
  }
  async getUnit() {
    return null;
  }
  async listUnits() {
    return [];
  }
  async createUnit() {}
  async updateUnit() {}
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

function fakeProvider(id = "tmdb"): MetadataProvider {
  return {
    id,
    search: vi.fn().mockResolvedValue([
      { externalId: "603", title: "Some Movie", year: 1999, overview: "...", posterUrl: null },
    ]),
    fetchDetails: vi.fn().mockResolvedValue({
      externalId: "603",
      title: `Some Movie (Canonical, ${id})`,
      overview: "...",
      year: 1999,
      posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg",
      backdropUrl: null,
    }),
  };
}

describe("metadata routes, disabled (no provider for this media kind)", () => {
  it("returns 503 on every metadata route", async () => {
    const app = buildApp({ libraryRepository: new InMemoryLibraryRepository([fakeNode()]), metadataProviders: {} });

    const candidates = await app.inject({ method: "GET", url: "/api/library/node-1/metadata/candidates" });
    expect(candidates.statusCode).toBe(503);

    const identify = await app.inject({
      method: "POST",
      url: "/api/library/node-1/metadata/identify",
      payload: { externalId: "603" },
    });
    expect(identify.statusCode).toBe(503);

    const autoIdentify = await app.inject({ method: "POST", url: "/api/library/auto-identify" });
    expect(autoIdentify.statusCode).toBe(503);
  });

  it("a configured series provider does not unblock movie routes", async () => {
    const app = buildApp({
      libraryRepository: new InMemoryLibraryRepository([fakeNode()]),
      metadataProviders: { series: fakeProvider("tvdb") },
    });

    const response = await app.inject({ method: "GET", url: "/api/library/node-1/metadata/candidates" });
    expect(response.statusCode).toBe(503);
  });
});

describe("POST /api/library/auto-identify", () => {
  it("delegates to autoIdentifyLibrary and returns its summary", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode()]);
    const app = buildApp({ libraryRepository: repo, metadataProviders: { movie: fakeProvider() } });

    const response = await app.inject({ method: "POST", url: "/api/library/auto-identify" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ identified: unknown[]; noMatch: unknown[]; alreadyIdentified: number }>();
    expect(body.identified).toHaveLength(1);
    const updated = await repo.getNode("node-1");
    expect(updated?.title).toBe("Some Movie (Canonical, tmdb)");
  });
});

describe("GET /api/library/:id/metadata/candidates", () => {
  it("searches using the node's title and the default provider for its media type", async () => {
    const provider = fakeProvider();
    const app = buildApp({
      libraryRepository: new InMemoryLibraryRepository([fakeNode()]),
      metadataProviders: { movie: provider },
    });

    const response = await app.inject({ method: "GET", url: "/api/library/node-1/metadata/candidates?year=1999" });

    expect(response.statusCode).toBe(200);
    expect(response.json().provider).toBe("tmdb");
    expect(provider.search).toHaveBeenCalledWith({ title: "Some Movie", year: 1999, mediaKind: "movie" });
  });

  it("an explicit ?provider= override is used instead of the media-type default", async () => {
    const tmdb = fakeProvider("tmdb");
    const tvdb = fakeProvider("tvdb");
    const app = buildApp({
      libraryRepository: new InMemoryLibraryRepository([fakeNode()]),
      metadataProviders: { movie: tmdb, series: tvdb },
    });

    const response = await app.inject({ method: "GET", url: "/api/library/node-1/metadata/candidates?provider=tvdb" });

    expect(response.statusCode).toBe(200);
    expect(response.json().provider).toBe("tvdb");
    expect(tmdb.search).not.toHaveBeenCalled();
    expect(tvdb.search).toHaveBeenCalledTimes(1);
  });

  it("rejects identification of a season node (non-root series node)", async () => {
    const season = fakeNode({ id: "season-1", mediaType: "series", kind: "collection", parentId: "series-1" });
    const app = buildApp({
      libraryRepository: new InMemoryLibraryRepository([season]),
      metadataProviders: { series: fakeProvider("tvdb") },
    });

    const response = await app.inject({ method: "GET", url: "/api/library/season-1/metadata/candidates" });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/library/:id/metadata/identify", () => {
  it("applies the canonical title and records the provider's external id", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode()]);
    const app = buildApp({ libraryRepository: repo, metadataProviders: { movie: fakeProvider() } });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/node-1/metadata/identify",
      payload: { externalId: "603" },
    });

    expect(response.statusCode).toBe(200);
    const updated = await repo.getNode("node-1");
    expect(updated?.title).toBe("Some Movie (Canonical, tmdb)");
    expect(updated?.externalIds).toEqual([
      { provider: "tmdb", entityType: "library_node", entityId: "node-1", providerId: "603" },
    ]);
  });

  it("returns 404 when the external id doesn't resolve to anything", async () => {
    const provider = fakeProvider();
    (provider.fetchDetails as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = buildApp({
      libraryRepository: new InMemoryLibraryRepository([fakeNode()]),
      metadataProviders: { movie: provider },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/node-1/metadata/identify",
      payload: { externalId: "999999" },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/library/:id/metadata", () => {
  it("returns 404 (not_identified) before an identify call has been made", async () => {
    const app = buildApp({
      libraryRepository: new InMemoryLibraryRepository([fakeNode()]),
      metadataProviders: { movie: fakeProvider() },
    });

    const response = await app.inject({ method: "GET", url: "/api/library/node-1/metadata" });

    expect(response.statusCode).toBe(404);
  });

  it("returns cached-provider details once identified", async () => {
    const node = fakeNode({
      externalIds: [{ provider: "tmdb", entityType: "library_node", entityId: "node-1", providerId: "603" }],
    });
    const app = buildApp({
      libraryRepository: new InMemoryLibraryRepository([node]),
      metadataProviders: { movie: fakeProvider() },
    });

    const response = await app.inject({ method: "GET", url: "/api/library/node-1/metadata" });

    expect(response.statusCode).toBe(200);
    expect(response.json().details.title).toBe("Some Movie (Canonical, tmdb)");
  });
});
