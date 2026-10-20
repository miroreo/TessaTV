import type { LibraryNode, LibraryRepository, MediaFile } from "@tessatv/domain";
import type { MetadataDetails, MetadataProvider } from "@tessatv/metadata";
import { describe, expect, it, vi } from "vitest";
import { refreshLibraryMetadata } from "./refresh-metadata.js";

class InMemoryLibraryRepository implements LibraryRepository {
  constructor(private readonly nodes: LibraryNode[] = []) {}

  async getNode(id: string) {
    return this.nodes.find((node) => node.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((node) => node.parentId === parentId);
  }
  async createNode() {}
  async updateNode() {}
  async deleteNode() {}
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
    sourceKey: "Some Movie (1999)",
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeDetails(overrides: Partial<MetadataDetails> = {}): MetadataDetails {
  return {
    externalId: "603",
    title: "Some Movie",
    overview: null,
    year: 1999,
    posterUrl: null,
    backdropUrl: null,
    ...overrides,
  };
}

function fakeProvider(id: string, overrides: Partial<MetadataProvider> = {}): MetadataProvider {
  return { id, search: vi.fn(), fetchDetails: vi.fn().mockResolvedValue(fakeDetails()), ...overrides };
}

describe("refreshLibraryMetadata", () => {
  it("refetches details for an already-identified node (a no-op read if its cache is still fresh)", async () => {
    const node = fakeNode({
      externalIds: [{ provider: "tmdb", entityType: "library_node", entityId: "node-1", providerId: "603" }],
    });
    const provider = fakeProvider("tmdb");
    const repo = new InMemoryLibraryRepository([node]);

    const summary = await refreshLibraryMetadata(repo, { movie: provider });

    expect(summary.refreshed).toEqual([{ nodeId: "node-1", title: "Some Movie" }]);
    expect(summary.skipped).toBe(0);
    expect(provider.fetchDetails).toHaveBeenCalledWith("603", "movie");
  });

  it("skips a root node that isn't identified yet for this provider — refresh has nothing to refresh", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode()]);
    const provider = fakeProvider("tmdb");

    const summary = await refreshLibraryMetadata(repo, { movie: provider });

    expect(summary.skipped).toBe(1);
    expect(summary.refreshed).toEqual([]);
    expect(provider.fetchDetails).not.toHaveBeenCalled();
  });

  it("records an error for one node without aborting the rest of the sweep", async () => {
    const nodeA = fakeNode({
      id: "node-a",
      externalIds: [{ provider: "tmdb", entityType: "library_node", entityId: "node-a", providerId: "1" }],
    });
    const nodeB = fakeNode({
      id: "node-b",
      title: "Other",
      externalIds: [{ provider: "tmdb", entityType: "library_node", entityId: "node-b", providerId: "2" }],
    });
    const provider = fakeProvider("tmdb", {
      fetchDetails: vi.fn().mockImplementation(async (externalId: string) => {
        if (externalId === "1") throw new Error("fetch failed");
        return fakeDetails({ title: "Other" });
      }),
    });
    const repo = new InMemoryLibraryRepository([nodeA, nodeB]);

    const summary = await refreshLibraryMetadata(repo, { movie: provider });

    expect(summary.errors).toEqual([{ nodeId: "node-a", title: "Some Movie", message: "fetch failed" }]);
    expect(summary.refreshed).toEqual([{ nodeId: "node-b", title: "Other" }]);
  });

  it("does not refresh a node whose media kind has no provider configured", async () => {
    const series = fakeNode({
      mediaType: "series",
      externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "node-1", providerId: "603" }],
    });
    const repo = new InMemoryLibraryRepository([series]);

    const summary = await refreshLibraryMetadata(repo, {});

    expect(summary.refreshed).toEqual([]);
    expect(summary.unavailable).toBe(1);
  });
});
