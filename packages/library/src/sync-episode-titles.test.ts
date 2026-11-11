import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import type { MetadataProvider } from "@tessatv/metadata";
import { describe, expect, it, vi } from "vitest";
import { syncEpisodeTitles } from "./sync-episode-titles.js";

class InMemoryLibraryRepository implements LibraryRepository {
  constructor(
    readonly nodes: LibraryNode[],
    readonly units: Unit[],
  ) {}

  async getNode(id: string) {
    return this.nodes.find((node) => node.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((node) => node.parentId === parentId);
  }
  async createNode() {}
  async updateNode(node: LibraryNode) {
    this.nodes[this.nodes.findIndex((existing) => existing.id === node.id)] = node;
  }
  async deleteNode() {}
  async getUnit() {
    return null;
  }
  async listUnits(libraryNodeId: string) {
    return this.units.filter((unit) => unit.libraryNodeId === libraryNodeId);
  }
  async createUnit() {}
  async updateUnit(unit: Unit) {
    this.units[this.units.findIndex((existing) => existing.id === unit.id)] = unit;
  }
  async listUnitLocations() {
    return [];
  }
  async moveWatchProgress() {}
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

function node(overrides: Partial<LibraryNode>): LibraryNode {
  return {
    id: "n",
    mediaType: "series",
    kind: "collection",
    parentId: null,
    title: "Suits",
    sortTitle: "suits",
    sourceKey: "Suits",
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function unit(id: string, nodeId: string, title: string, season: number, episode: number): Unit {
  return {
    id,
    libraryNodeId: nodeId,
    mediaType: "series",
    title,
    sequence: { path: [season, episode] },
    externalIds: [],
    availability: "available",
    mediaFileId: "f",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function library() {
  return new InMemoryLibraryRepository(
    [
      node({ id: "series", externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "series", providerId: "247808" }] }),
      node({ id: "season-1", parentId: "series", title: "Season 1" }),
      node({ id: "ep-4", parentId: "season-1", kind: "leaf", title: "ReEnc", sortTitle: "reenc" }),
      node({ id: "ep-5", parentId: "season-1", kind: "leaf", title: "Episode 5", sortTitle: "episode 5" }),
      node({ id: "ep-9", parentId: "season-1", kind: "leaf", title: "Unlisted", sortTitle: "unlisted" }),
      node({ id: "other", title: "Unidentified Show" }),
    ],
    [unit("u4", "ep-4", "ReEnc", 1, 4), unit("u5", "ep-5", "Episode 5", 1, 5), unit("u9", "ep-9", "Unlisted", 1, 9)],
  );
}

function provider(fetchEpisodes: MetadataProvider["fetchEpisodes"]): MetadataProvider {
  return { id: "tvdb", search: vi.fn(), fetchDetails: vi.fn(), fetchEpisodes };
}

describe("syncEpisodeTitles", () => {
  it("renames an identified series' episodes, node and unit, by season/episode", async () => {
    const repository = library();
    const fetchEpisodes = vi.fn().mockResolvedValue([
      { season: 1, episode: 4, title: "Dead Drop" },
      { season: 1, episode: 5, title: "Bail Out" },
    ]);

    const summary = await syncEpisodeTitles(repository, { series: provider(fetchEpisodes) });

    expect(summary).toEqual({ retitled: 2, errors: [] });
    expect(fetchEpisodes).toHaveBeenCalledWith("247808");
    expect(repository.nodes.find((n) => n.id === "ep-4")).toMatchObject({ title: "Dead Drop", sortTitle: "dead drop" });
    expect(repository.units.map((u) => u.title)).toEqual(["Dead Drop", "Bail Out", "Unlisted"]);
  });

  it("is a no-op the second time, and leaves episodes the provider doesn't list alone", async () => {
    const repository = library();
    const fetchEpisodes = vi.fn().mockResolvedValue([{ season: 1, episode: 4, title: "Dead Drop" }]);

    await syncEpisodeTitles(repository, { series: provider(fetchEpisodes) });
    const again = await syncEpisodeTitles(repository, { series: provider(fetchEpisodes) });

    expect(again.retitled).toBe(0);
    expect(repository.nodes.find((n) => n.id === "ep-9")?.title).toBe("Unlisted");
  });

  it("skips a provider that can't list episodes", async () => {
    const repository = library();

    const summary = await syncEpisodeTitles(repository, { series: provider(undefined) });

    expect(summary).toEqual({ retitled: 0, errors: [] });
    expect(repository.units[0]?.title).toBe("ReEnc");
  });

  it("records a failing series and carries on", async () => {
    const repository = library();
    const fetchEpisodes = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const summary = await syncEpisodeTitles(repository, { series: provider(fetchEpisodes) });

    expect(summary).toEqual({ retitled: 0, errors: [{ nodeId: "series", title: "Suits", message: "fetch failed" }] });
  });
});
