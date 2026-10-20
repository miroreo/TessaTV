import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import type { MetadataProvider, MetadataSearchCandidate } from "@tessatv/metadata";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";

class InMemoryLibraryRepository implements LibraryRepository {
  nodes = new Map<string, LibraryNode>();
  units = new Map<string, Unit>();

  async getNode(id: string) {
    return this.nodes.get(id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return Array.from(this.nodes.values()).filter((node) => node.parentId === parentId);
  }
  async createNode(node: LibraryNode) {
    this.nodes.set(node.id, node);
  }
  async updateNode(node: LibraryNode) {
    this.nodes.set(node.id, node);
  }
  async deleteNode(id: string) {
    this.nodes.delete(id);
  }
  async getUnit(id: string) {
    return this.units.get(id) ?? null;
  }
  async listUnits(libraryNodeId: string) {
    return Array.from(this.units.values()).filter((unit) => unit.libraryNodeId === libraryNodeId);
  }
  async createUnit(unit: Unit) {
    this.units.set(unit.id, unit);
  }
  async updateUnit(unit: Unit) {
    this.units.set(unit.id, unit);
  }
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

function makeNode(overrides: Partial<LibraryNode> & { id: string }): LibraryNode {
  const now = new Date();
  return {
    kind: "collection",
    mediaType: "series",
    parentId: null,
    title: overrides.id,
    sortTitle: overrides.id,
    sourceKey: overrides.id,
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeTvdbProvider(candidateCount = 1): MetadataProvider {
  return {
    id: "tvdb",
    search: vi.fn().mockImplementation(async ({ title }: { title: string }) =>
      Array.from({ length: candidateCount }, (_, i): MetadataSearchCandidate => ({
        externalId: String(i),
        title,
        year: null,
        overview: null,
        posterUrl: null,
      })),
    ),
    fetchDetails: vi.fn(),
  };
}

describe("POST /api/library/merge-duplicates", () => {
  it("auto-merges an unambiguous duplicate pair and returns the summary", async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.createNode(
      makeNode({
        id: "series-a",
        sourceKey: "Show",
        createdAt: new Date(2020, 0, 1),
        externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-a", providerId: "1" }],
      }),
    );
    await repo.createNode(
      makeNode({
        id: "series-b",
        sourceKey: "Show",
        createdAt: new Date(2021, 0, 1),
        externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-b", providerId: "1" }],
      }),
    );

    const app = buildApp({ libraryRepository: repo, metadataProviders: { series: fakeTvdbProvider(1) } });
    const response = await app.inject({ method: "POST", url: "/api/library/merge-duplicates" });

    expect(response.statusCode).toBe(200);
    expect(response.json().merged).toEqual([
      { primaryNodeId: "series-a", mergedNodeId: "series-b", provider: "tvdb", externalId: "1" },
    ]);
    expect(await repo.getNode("series-b")).toBeNull();
  });
});

describe("POST /api/library/merge-duplicates/confirm", () => {
  it("merges an explicitly confirmed pending pair", async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.createNode(makeNode({ id: "series-a" }));
    await repo.createNode(makeNode({ id: "series-b" }));
    const app = buildApp({ libraryRepository: repo, metadataProviders: {} });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/merge-duplicates/confirm",
      payload: { primaryNodeId: "series-a", duplicateNodeId: "series-b" },
    });

    expect(response.statusCode).toBe(200);
    expect(await repo.getNode("series-b")).toBeNull();
  });

  it("returns 404 when either node doesn't exist", async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.createNode(makeNode({ id: "series-a" }));
    const app = buildApp({ libraryRepository: repo, metadataProviders: {} });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/merge-duplicates/confirm",
      payload: { primaryNodeId: "series-a", duplicateNodeId: "missing" },
    });

    expect(response.statusCode).toBe(404);
  });
});
