import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import type { MetadataProvider, MetadataSearchCandidate } from "@tessatv/metadata";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { confirmSeriesMerge, mergeDuplicateSeries } from "./merge-duplicate-series.js";

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

async function addEpisode(
  repo: InMemoryLibraryRepository,
  seasonId: string,
  season: number,
  episode: number,
): Promise<void> {
  const episodeId = randomUUID();
  await repo.createNode(
    makeNode({ id: episodeId, kind: "leaf", parentId: seasonId, sourceKey: `episode:${season}:${episode}` }),
  );
  await repo.createUnit({
    id: randomUUID(),
    libraryNodeId: episodeId,
    mediaType: "series",
    title: `S${season}E${episode}`,
    sequence: { path: [season, episode] },
    externalIds: [],
    availability: "available",
    mediaFileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function fakeProvider(candidatesPerTitle: Record<string, number>): MetadataProvider {
  return {
    id: "tvdb",
    search: vi.fn().mockImplementation(async ({ title }: { title: string }) => {
      const count = candidatesPerTitle[title] ?? 1;
      return Array.from({ length: count }, (_, i): MetadataSearchCandidate => ({
        externalId: String(100 + i),
        title,
        year: null,
        overview: null,
        posterUrl: null,
      }));
    }),
    fetchDetails: vi.fn(),
  };
}

describe("mergeDuplicateSeries", () => {
  it("merges two series sharing an external id when both sides are unambiguous", async () => {
    const repo = new InMemoryLibraryRepository();
    const earlier = makeNode({
      id: "series-a",
      sourceKey: "Ink Master",
      createdAt: new Date(2020, 0, 1),
      externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-a", providerId: "500" }],
    });
    const later = makeNode({
      id: "series-b",
      sourceKey: "Ink.Master",
      createdAt: new Date(2021, 0, 1),
      externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-b", providerId: "500" }],
    });
    await repo.createNode(earlier);
    await repo.createNode(later);

    const season9 = makeNode({ id: "season-9", parentId: "series-a", sourceKey: "season:9", title: "Season 9" });
    const season17 = makeNode({ id: "season-17", parentId: "series-b", sourceKey: "season:17", title: "Season 17" });
    await repo.createNode(season9);
    await repo.createNode(season17);
    await addEpisode(repo, "season-9", 9, 1);
    await addEpisode(repo, "season-17", 17, 1);

    const provider = fakeProvider({ "Ink Master": 1 });
    const summary = await mergeDuplicateSeries(repo, provider);

    expect(summary.merged).toEqual([
      { primaryNodeId: "series-a", mergedNodeId: "series-b", provider: "tvdb", externalId: "500" },
    ]);
    expect(summary.pending).toEqual([]);
    expect(await repo.getNode("series-b")).toBeNull();
    const primarySeasons = await repo.listChildren("series-a");
    expect(primarySeasons.map((s) => s.sourceKey).sort()).toEqual(["season:17", "season:9"]);
    // The moved season kept its own id, just reparented.
    const movedSeason = primarySeasons.find((s) => s.sourceKey === "season:17");
    expect(movedSeason?.id).toBe("season-17");
  });

  it("reconciles a season-number collision by keeping the primary's episode and dropping the duplicate's", async () => {
    const repo = new InMemoryLibraryRepository();
    const earlier = makeNode({
      id: "series-a",
      sourceKey: "Show A",
      createdAt: new Date(2020, 0, 1),
      externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-a", providerId: "500" }],
    });
    const later = makeNode({
      id: "series-b",
      sourceKey: "Show B",
      createdAt: new Date(2021, 0, 1),
      externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-b", providerId: "500" }],
    });
    await repo.createNode(earlier);
    await repo.createNode(later);

    // Both sides have season 1 — a genuine collision.
    await repo.createNode(makeNode({ id: "season-a1", parentId: "series-a", sourceKey: "season:1" }));
    await repo.createNode(makeNode({ id: "season-b1", parentId: "series-b", sourceKey: "season:1" }));
    await addEpisode(repo, "season-a1", 1, 1); // primary already has S1E1
    await addEpisode(repo, "season-b1", 1, 1); // duplicate's S1E1 is redundant
    await addEpisode(repo, "season-b1", 1, 2); // duplicate's S1E2 is new

    const provider = fakeProvider({ "Show A": 1, "Show B": 1 });
    await mergeDuplicateSeries(repo, provider);

    const primarySeasons = await repo.listChildren("series-a");
    expect(primarySeasons).toHaveLength(1);
    const episodes = await repo.listChildren(primarySeasons[0]!.id);
    expect(episodes).toHaveLength(2); // S1E1 (original) + S1E2 (moved), S1E1 duplicate dropped
    expect(await repo.getNode("season-b1")).toBeNull();
  });

  it("does not merge, and reports pending, when either side's match is ambiguous", async () => {
    const repo = new InMemoryLibraryRepository();
    const earlier = makeNode({
      id: "series-a",
      sourceKey: "Common Name",
      createdAt: new Date(2020, 0, 1),
      externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-a", providerId: "500" }],
    });
    const later = makeNode({
      id: "series-b",
      sourceKey: "Common Name",
      createdAt: new Date(2021, 0, 1),
      externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series-b", providerId: "500" }],
    });
    await repo.createNode(earlier);
    await repo.createNode(later);

    const provider = fakeProvider({ "Common Name": 3 }); // ambiguous: 3 candidates
    const summary = await mergeDuplicateSeries(repo, provider);

    expect(summary.merged).toEqual([]);
    expect(summary.pending).toEqual([
      {
        primaryNodeId: "series-a",
        duplicateNodeId: "series-b",
        provider: "tvdb",
        externalId: "500",
        reason: "one or both sources had other possible matches — not merged automatically",
      },
    ]);
    expect(await repo.getNode("series-b")).not.toBeNull();
  });

  it("returns empty results when no provider is configured for series", async () => {
    const repo = new InMemoryLibraryRepository();
    const summary = await mergeDuplicateSeries(repo, undefined);
    expect(summary).toEqual({ merged: [], pending: [] });
  });
});

describe("confirmSeriesMerge", () => {
  it("merges an explicitly-confirmed pair, bypassing the ambiguity check", async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.createNode(makeNode({ id: "series-a", sourceKey: "Common Name" }));
    await repo.createNode(makeNode({ id: "series-b", sourceKey: "Common Name" }));
    await repo.createNode(makeNode({ id: "season-b1", parentId: "series-b", sourceKey: "season:1" }));

    await confirmSeriesMerge(repo, "series-a", "series-b");

    expect(await repo.getNode("series-b")).toBeNull();
    const primarySeasons = await repo.listChildren("series-a");
    expect(primarySeasons.map((s) => s.id)).toEqual(["season-b1"]);
  });
});
