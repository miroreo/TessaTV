import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

function fakeNode(overrides: Partial<LibraryNode> = {}): LibraryNode {
  return {
    id: "node-1",
    mediaType: "movie",
    kind: "leaf",
    parentId: null,
    title: "Example Movie",
    sortTitle: "example movie",
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

class InMemoryLibraryRepository implements LibraryRepository {
  constructor(private readonly nodes: LibraryNode[] = [], private readonly units: Unit[] = []) {}

  async getNode(id: string) {
    return this.nodes.find((node) => node.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((node) => node.parentId === parentId);
  }
  async createNode() {}
  async updateNode() {}
  async getUnit(id: string) {
    return this.units.find((unit) => unit.id === id) ?? null;
  }
  async listUnits(libraryNodeId: string) {
    return this.units.filter((unit) => unit.libraryNodeId === libraryNodeId);
  }
  async createUnit() {}
  async updateUnit() {}
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

describe("GET /health", () => {
  it("reports ok", async () => {
    const app = buildApp({ metadataProviders: {}, libraryRepository:new InMemoryLibraryRepository() });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/library", () => {
  it("lists root library nodes", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode()]);
    const app = buildApp({ metadataProviders: {}, libraryRepository:repo });

    const response = await app.inject({ method: "GET", url: "/api/library" });
    const body = response.json<{ items: LibraryNode[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("Example Movie");
  });
});

describe("GET /api/library/:id/units", () => {
  it("returns 404 for an unknown node", async () => {
    const app = buildApp({ metadataProviders: {}, libraryRepository:new InMemoryLibraryRepository() });
    const response = await app.inject({ method: "GET", url: "/api/library/missing/units" });
    expect(response.statusCode).toBe(404);
  });
});
