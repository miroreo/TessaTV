import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importMovies, importShows } from "./importer.js";
import type { ScannedMovie } from "./scan-movies.js";
import type { ScannedSeries } from "./scan-shows.js";

class InMemoryLibraryRepository implements LibraryRepository {
  nodes = new Map<string, LibraryNode>();
  units = new Map<string, Unit>();
  files = new Map<string, MediaFile>();

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
  async getMediaFile(id: string) {
    return this.files.get(id) ?? null;
  }
  async createMediaFile(file: MediaFile) {
    this.files.set(file.id, file);
  }
}

function sampleMovie(overrides: Partial<ScannedMovie> = {}): ScannedMovie {
  return {
    title: `Sample Movie ${randomUUID().slice(0, 8)}`,
    year: 2000,
    filePath: "/library/movies/sample/movie.mkv",
    sizeBytes: 1_000_000,
    container: "mkv",
    ...overrides,
  };
}

describe("importMovies", () => {
  it("creates a leaf node, unit, and media file for a scanned movie", async () => {
    const repo = new InMemoryLibraryRepository();
    const movie = sampleMovie({ title: "Example Movie" });

    const result = await importMovies(repo, [movie]);

    expect(result).toEqual({ created: 1, skipped: 0 });
    const [node] = await repo.listChildren(null);
    expect(node?.title).toBe("Example Movie");
    expect(node?.kind).toBe("leaf");

    const [unit] = await repo.listUnits(node!.id);
    expect(unit?.availability).toBe("available");
    expect(unit?.sequence.path).toEqual([]);

    const file = unit?.mediaFileId ? await repo.getMediaFile(unit.mediaFileId) : null;
    expect(file?.path).toBe(movie.filePath);
  });

  it("is idempotent: re-importing the same title skips instead of duplicating", async () => {
    const repo = new InMemoryLibraryRepository();
    const movie = sampleMovie({ title: "Example Movie" });

    await importMovies(repo, [movie]);
    const second = await importMovies(repo, [movie]);

    expect(second).toEqual({ created: 0, skipped: 1 });
    expect(await repo.listChildren(null)).toHaveLength(1);
  });
});

function sampleSeries(episodes: ScannedSeries["episodes"], title = "Example Series"): ScannedSeries {
  return { title, episodes };
}

describe("importShows", () => {
  it("creates a series collection, one collection per distinct season, and a leaf per episode", async () => {
    const repo = new InMemoryLibraryRepository();
    const series = sampleSeries([
      { season: 1, episode: 1, title: "First", filePath: "/s1e1.mkv", sizeBytes: 100, container: "mkv" },
      { season: 1, episode: 2, title: "Second", filePath: "/s1e2.mkv", sizeBytes: 100, container: "mkv" },
      { season: 2, episode: 1, title: "Third", filePath: "/s2e1.mkv", sizeBytes: 100, container: "mkv" },
    ]);

    const result = await importShows(repo, [series]);

    expect(result).toEqual({ created: 3, skipped: 0 });

    const [seriesNode] = await repo.listChildren(null);
    expect(seriesNode?.kind).toBe("collection");

    const seasonNodes = await repo.listChildren(seriesNode!.id);
    expect(seasonNodes.map((node) => node.title).sort()).toEqual(["Season 1", "Season 2"]);

    const season1 = seasonNodes.find((node) => node.title === "Season 1")!;
    const season1Episodes = await repo.listChildren(season1.id);
    expect(season1Episodes).toHaveLength(2);
  });

  it("is idempotent per (season, episode), not per title", async () => {
    const repo = new InMemoryLibraryRepository();
    const episodes: ScannedSeries["episodes"] = [
      { season: 1, episode: 1, title: "First", filePath: "/s1e1.mkv", sizeBytes: 100, container: "mkv" },
    ];

    await importShows(repo, [sampleSeries(episodes)]);
    const second = await importShows(repo, [sampleSeries(episodes)]);

    expect(second).toEqual({ created: 0, skipped: 1 });
  });
});
