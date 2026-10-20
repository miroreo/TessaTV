import type { LibraryNode, LibraryRepository, MediaFile } from "@tessatv/domain";
import type { MetadataDetails, MetadataProvider, MetadataSearchCandidate } from "@tessatv/metadata";
import { describe, expect, it, vi } from "vitest";
import { autoIdentifyLibrary } from "./auto-identify.js";

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

function fakeNode(overrides: Partial<LibraryNode> = {}): LibraryNode {
  return {
    id: "node-1",
    mediaType: "movie",
    kind: "leaf",
    parentId: null,
    title: "Some Movie",
    sortTitle: "some movie",
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeCandidate(overrides: Partial<MetadataSearchCandidate> = {}): MetadataSearchCandidate {
  return { externalId: "603", title: "Some Movie", year: 1999, overview: null, posterUrl: null, ...overrides };
}

function fakeDetails(overrides: Partial<MetadataDetails> = {}): MetadataDetails {
  return {
    externalId: "603",
    title: "Some Movie (Canonical)",
    overview: null,
    year: 1999,
    posterUrl: null,
    backdropUrl: null,
    ...overrides,
  };
}

describe("autoIdentifyLibrary", () => {
  it("auto-applies the top search candidate for each unidentified root node", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode()]);
    const provider: MetadataProvider = {
      id: "tmdb",
      search: vi.fn().mockResolvedValue([fakeCandidate()]),
      fetchDetails: vi.fn().mockResolvedValue(fakeDetails()),
    };

    const summary = await autoIdentifyLibrary(repo, provider);

    expect(summary.identified).toEqual([
      { nodeId: "node-1", previousTitle: "Some Movie", matchedTitle: "Some Movie (Canonical)", externalId: "603" },
    ]);
    expect(summary.noMatch).toEqual([]);
    expect(summary.alreadyIdentified).toBe(0);

    const updated = await repo.getNode("node-1");
    expect(updated?.title).toBe("Some Movie (Canonical)");
    expect(updated?.externalIds).toEqual([
      { provider: "tmdb", entityType: "library_node", entityId: "node-1", providerId: "603" },
    ]);
  });

  it("skips nodes that already have an external id from this provider", async () => {
    const node = fakeNode({
      externalIds: [{ provider: "tmdb", entityType: "library_node", entityId: "node-1", providerId: "603" }],
    });
    const repo = new InMemoryLibraryRepository([node]);
    const provider: MetadataProvider = { id: "tmdb", search: vi.fn(), fetchDetails: vi.fn() };

    const summary = await autoIdentifyLibrary(repo, provider);

    expect(summary.alreadyIdentified).toBe(1);
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("records a miss when search returns no candidates, without touching the node", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode()]);
    const provider: MetadataProvider = {
      id: "tmdb",
      search: vi.fn().mockResolvedValue([]),
      fetchDetails: vi.fn(),
    };

    const summary = await autoIdentifyLibrary(repo, provider);

    expect(summary.noMatch).toEqual([{ nodeId: "node-1", title: "Some Movie" }]);
    expect(provider.fetchDetails).not.toHaveBeenCalled();
    expect((await repo.getNode("node-1"))?.externalIds).toEqual([]);
  });

  it("records an error for one node without aborting the rest of the sweep", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode({ id: "node-1" }), fakeNode({ id: "node-2", title: "Other Movie" })]);
    const provider: MetadataProvider = {
      id: "tmdb",
      search: vi.fn().mockImplementation(async ({ title }: { title: string }) => {
        if (title === "Some Movie") throw new Error("fetch failed");
        return [fakeCandidate({ title: "Other Movie" })];
      }),
      fetchDetails: vi.fn().mockResolvedValue(fakeDetails({ title: "Other Movie (Canonical)" })),
    };

    const summary = await autoIdentifyLibrary(repo, provider);

    expect(summary.errors).toEqual([{ nodeId: "node-1", title: "Some Movie", message: "fetch failed" }]);
    expect(summary.identified).toEqual([
      { nodeId: "node-2", previousTitle: "Other Movie", matchedTitle: "Other Movie (Canonical)", externalId: "603" },
    ]);
  });

  it("skips season/episode nodes (non-root), since listChildren(null) never returns them", async () => {
    const root = fakeNode({ id: "series-1", mediaType: "series", kind: "collection" });
    const season = fakeNode({ id: "season-1", mediaType: "series", kind: "collection", parentId: "series-1" });
    const repo = new InMemoryLibraryRepository([root, season]);
    const provider: MetadataProvider = {
      id: "tmdb",
      search: vi.fn().mockResolvedValue([fakeCandidate()]),
      fetchDetails: vi.fn().mockResolvedValue(fakeDetails()),
    };

    await autoIdentifyLibrary(repo, provider);

    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.search).toHaveBeenCalledWith({ title: "Some Movie", year: null, mediaKind: "series" });
  });
});
