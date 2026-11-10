import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import type { MetadataProvider, MetadataSearchCandidate } from "@tessatv/metadata";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { confirmSeriesMerge, InvalidSeriesMergeError, mergeDuplicateSeries } from "./merge-duplicate-series.js";

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
  /** Unit ids with watch history. Like the real database, deleting one's node is refused. */
  watched = new Set<string>();
  async deleteNode(id: string) {
    if ((await this.listUnits(id)).some((unit) => this.watched.has(unit.id))) {
      throw new Error(`node ${id} still has watch history`);
    }
    this.nodes.delete(id);
  }
  async moveWatchProgress(fromUnitId: string, toUnitId: string) {
    if (this.watched.delete(fromUnitId)) this.watched.add(toUnitId);
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
  files = new Map<string, MediaFile>();
  async getMediaFile(id: string): Promise<MediaFile | null> {
    return this.files.get(id) ?? null;
  }
  async createMediaFile(file: MediaFile) {
    this.files.set(file.id, file);
  }
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

  it("carries watch history from a duplicate episode over to the one it keeps", async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.createNode(makeNode({ id: "series-a", sourceKey: "Common Name" }));
    await repo.createNode(makeNode({ id: "season-a1", parentId: "series-a", sourceKey: "season:1" }));
    await repo.createNode(makeNode({ id: "series-b", sourceKey: "Common Name" }));
    await repo.createNode(makeNode({ id: "season-b1", parentId: "series-b", sourceKey: "season:1" }));
    await addEpisode(repo, "season-a1", 1, 1);
    await addEpisode(repo, "season-b1", 1, 1);
    const unitIn = async (seasonId: string) => (await repo.listUnits((await repo.listChildren(seasonId))[0]!.id))[0]!;
    const [kept, duplicate] = [await unitIn("season-a1"), await unitIn("season-b1")];
    repo.watched.add(duplicate.id);

    await confirmSeriesMerge(repo, "series-a", "series-b");

    expect(await repo.getNode("series-b")).toBeNull();
    expect([...repo.watched]).toEqual([kept.id]);
  });

  it("refuses to merge a series into itself, which would delete every episode", async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.createNode(makeNode({ id: "series-a", sourceKey: "Show" }));
    await repo.createNode(makeNode({ id: "season-a1", parentId: "series-a", sourceKey: "season:1" }));
    await addEpisode(repo, "season-a1", 1, 1);

    await expect(confirmSeriesMerge(repo, "series-a", "series-a")).rejects.toBeInstanceOf(InvalidSeriesMergeError);
    expect(repo.nodes.size).toBe(3);
  });

  it("refuses anything but two top-level series", async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.createNode(makeNode({ id: "series-a", sourceKey: "Show" }));
    await repo.createNode(makeNode({ id: "season-a1", parentId: "series-a", sourceKey: "season:1" }));
    await repo.createNode(makeNode({ id: "movie", mediaType: "movie", kind: "leaf", sourceKey: "Movie" }));

    await expect(confirmSeriesMerge(repo, "series-a", "season-a1")).rejects.toBeInstanceOf(InvalidSeriesMergeError);
    await expect(confirmSeriesMerge(repo, "movie", "series-a")).rejects.toBeInstanceOf(InvalidSeriesMergeError);
    expect(repo.nodes.size).toBe(3);
  });
});

describe("merging remembers the duplicate's folder", () => {
  it("so a later scan of that folder lands on the survivor instead of recreating the series", async () => {
    const { importShows } = await import("./importer.js");
    const repository = new InMemoryLibraryRepository();
    const episode = (season: number, n: number) => ({
      season, episode: n, title: `E${n}`, filePath: `/shows/Show.Name/S0${season}E0${n}.mkv`, sizeBytes: 1, container: "mkv",
    });
    await importShows(repository, [{ title: "Show Name", folderName: "Show Name", episodes: [{ ...episode(1, 1), filePath: "/shows/Show Name/S01E01.mkv" }] }]);
    await importShows(repository, [{ title: "Show Name", folderName: "Show.Name", episodes: [episode(2, 1)] }]);
    const [primary, duplicate] = await repository.listChildren(null);
    await confirmSeriesMerge(repository, primary!.id, duplicate!.id);
    expect((await repository.getNode(primary!.id))?.sourceAliases).toEqual(["Show.Name"]);

    const rescan = await importShows(repository, [{ title: "Show Name", folderName: "Show.Name", episodes: [episode(2, 1)] }]);
    expect(rescan).toEqual({ created: 0, skipped: 1, relinked: 0 });
    expect((await repository.listChildren(null)).map((node) => node.id)).toEqual([primary!.id]);
  });
});
