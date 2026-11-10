import type { LibraryNode, LibraryRepository, MediaFile, Unit, WatchProgress, WatchProgressRepository } from "@tessatv/domain";
import { describe, expect, it } from "vitest";
import { continueWatching, listUnitsUnder, nextUp, pickNextUnit } from "./watch-history.js";

class InMemoryLibraryRepository implements LibraryRepository {
  nodes = new Map<string, LibraryNode>();
  units = new Map<string, Unit>();
  async getNode(id: string) {
    return this.nodes.get(id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return [...this.nodes.values()].filter((node) => node.parentId === parentId);
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
    return [...this.units.values()].filter((unit) => unit.libraryNodeId === libraryNodeId);
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

class InMemoryProgress implements WatchProgressRepository {
  rows: WatchProgress[] = [];
  async get(userId: string, unitId: string) {
    return this.rows.find((row) => row.userId === userId && row.unitId === unitId) ?? null;
  }
  async save(progress: WatchProgress) {
    this.rows = [...this.rows.filter((row) => !(row.userId === progress.userId && row.unitId === progress.unitId)), progress];
  }
  async listRecent(userId: string, limit: number) {
    return this.rows
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }
  async listForUnits(userId: string, unitIds: readonly string[]) {
    return this.rows.filter((row) => row.userId === userId && unitIds.includes(row.unitId));
  }
}

const NOW = new Date(0);
function node(id: string, kind: LibraryNode["kind"], parentId: string | null, mediaType = "series"): LibraryNode {
  return {
    id, kind, parentId, mediaType, title: id, sortTitle: id, sourceKey: id, externalIds: [],
    monitored: true, qualityProfileId: null, createdAt: NOW, updatedAt: NOW,
  };
}
function unit(id: string, libraryNodeId: string, path: number[], mediaFileId: string | null = `file-${id}`): Unit {
  return {
    id, libraryNodeId, mediaType: "series", title: id, sequence: { path }, externalIds: [],
    availability: "available", mediaFileId, createdAt: NOW, updatedAt: NOW,
  };
}
function progress(unitId: string, at: number, overrides: Partial<WatchProgress> = {}): WatchProgress {
  return { userId: "u", unitId, positionSeconds: 600, durationSeconds: 1200, completed: false, updatedAt: new Date(at), ...overrides };
}

/** A two-season show (inserted out of order, to prove sorting) plus a movie. */
async function library() {
  const repo = new InMemoryLibraryRepository();
  for (const n of [
    node("show", "collection", null),
    node("s2", "collection", "show"),
    node("s1", "collection", "show"),
    node("e2x1", "leaf", "s2"),
    node("e1x2", "leaf", "s1"),
    node("e1x1", "leaf", "s1"),
    node("movie", "leaf", null, "movie"),
  ]) await repo.createNode(n);
  for (const u of [unit("ep2x1", "e2x1", [2, 1]), unit("ep1x2", "e1x2", [1, 2]), unit("ep1x1", "e1x1", [1, 1]), unit("film", "movie", [])]) {
    await repo.createUnit(u);
  }
  return repo;
}

describe("listUnitsUnder", () => {
  it("collects every episode across seasons in order", async () => {
    expect((await listUnitsUnder(await library(), "show")).map((u) => u.id)).toEqual(["ep1x1", "ep1x2", "ep2x1"]);
  });
});

describe("pickNextUnit", () => {
  const units = [unit("a", "x", [1, 1]), unit("b", "x", [1, 2]), unit("c", "x", [1, 3])];
  it("starts at the beginning with no history", () => {
    expect(pickNextUnit(units, [])?.id).toBe("a");
  });
  it("resumes the latest episode if it's unfinished", () => {
    expect(pickNextUnit(units, [progress("a", 1, { completed: true }), progress("b", 2)])?.id).toBe("b");
  });
  it("moves past the latest episode once it's finished, even if an earlier one isn't", () => {
    expect(pickNextUnit(units, [progress("a", 1), progress("b", 2, { completed: true })])?.id).toBe("c");
  });
  it("has nothing next after the final episode, and skips episodes with no file", () => {
    expect(pickNextUnit(units, [progress("c", 1, { completed: true })])).toBeNull();
    expect(pickNextUnit([unit("a", "x", [1, 1], null), units[1]!], [])?.id).toBe("b");
  });
});

describe("continueWatching / nextUp", () => {
  it("lists unfinished items most recent first, skipping finished and barely-started ones", async () => {
    const progressRepo = new InMemoryProgress();
    await progressRepo.save(progress("film", 3));
    await progressRepo.save(progress("ep1x1", 2));
    await progressRepo.save(progress("ep1x2", 4, { positionSeconds: 5 }));
    await progressRepo.save(progress("ep2x1", 1, { completed: true }));
    const entries = await continueWatching(await library(), progressRepo, "u");
    expect(entries.map((entry) => [entry.unit.id, entry.root.id])).toEqual([["film", "movie"], ["ep1x1", "show"]]);
  });

  it("offers the next episode only for series whose latest activity was finishing one", async () => {
    const repo = await library();
    const progressRepo = new InMemoryProgress();
    await progressRepo.save(progress("ep1x2", 1, { completed: true }));
    expect((await nextUp(repo, progressRepo, "u")).map((entry) => entry.unit.id)).toEqual(["ep2x1"]);

    await progressRepo.save(progress("ep2x1", 2));
    expect(await nextUp(repo, progressRepo, "u")).toEqual([]);
  });

  it("ignores progress for units that no longer exist", async () => {
    const progressRepo = new InMemoryProgress();
    await progressRepo.save(progress("deleted", 1));
    expect(await continueWatching(await library(), progressRepo, "u")).toEqual([]);
  });
});
