import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LibraryFolder,
  LibraryNode,
  LibraryRepository,
  MediaAvailabilityRepository,
  MediaFile,
  MediaFileLocation,
  Unit,
  UnitAvailability,
} from "@tessatv/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanLibrary } from "./library-scan.js";

class InMemoryLibrary implements LibraryRepository, MediaAvailabilityRepository {
  nodes = new Map<string, LibraryNode>();
  units = new Map<string, Unit>();
  files = new Map<string, MediaFile>();
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
  async getMediaFile(id: string) {
    return this.files.get(id) ?? null;
  }
  async createMediaFile(file: MediaFile) {
    this.files.set(file.id, file);
  }
  async listFilesUnder(folder: string): Promise<MediaFileLocation[]> {
    return [...this.files.values()]
      .filter((file) => file.path.startsWith(`${folder}/`))
      .map((file) => ({ unitId: file.unitId, path: file.path, availability: this.units.get(file.unitId)!.availability }));
  }
  async setAvailability(unitIds: readonly string[], availability: UnitAvailability) {
    for (const id of unitIds) this.units.set(id, { ...this.units.get(id)!, availability });
  }
  async listRootsWithPlayableUnits() {
    return new Set<string>();
  }
}

describe("scanLibrary", () => {
  let root: string;
  let shows: string;
  let library: InMemoryLibrary;
  const folder = (path: string, mediaType: LibraryFolder["mediaType"] = "series"): LibraryFolder => ({
    id: path, mediaType, path, createdAt: new Date(0),
  });
  const scan = (folders: LibraryFolder[]) => scanLibrary(folders, { repository: library, availability: library, providers: {} });
  const episodePath = (n: number) => join(shows, "Show", "Season 01", `Show.S01E0${n}.mkv`);
  const availabilityByEpisode = () =>
    Object.fromEntries([...library.units.values()].map((unit) => [unit.sequence.path[1], unit.availability]));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tessatv-scan-test-"));
    shows = join(root, "shows");
    await mkdir(join(shows, "Show", "Season 01"), { recursive: true });
    for (const n of [1, 2]) await writeFile(episodePath(n), "x");
    library = new InMemoryLibrary();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("imports new files, and only new ones on the next run", async () => {
    expect((await scan([folder(shows)])).import.shows).toMatchObject({ created: 2 });
    await writeFile(episodePath(3), "x");
    expect((await scan([folder(shows)])).import.shows).toMatchObject({ created: 1 });
    expect(library.units.size).toBe(3);
  });

  it("hides a file that disappears and restores it when it comes back, keeping the same unit", async () => {
    await scan([folder(shows)]);
    const before = [...library.units.keys()].sort();

    await rm(episodePath(2));
    expect(await scan([folder(shows)])).toMatchObject({ markedMissing: 1, restored: 0 });
    expect(availabilityByEpisode()).toEqual({ 1: "available", 2: "missing" });

    await writeFile(episodePath(2), "x");
    expect(await scan([folder(shows)])).toMatchObject({ markedMissing: 0, restored: 1 });
    expect(availabilityByEpisode()).toEqual({ 1: "available", 2: "available" });
    expect([...library.units.keys()].sort()).toEqual(before);
  });

  it("never treats an unreachable or empty folder as everything having been deleted", async () => {
    await scan([folder(shows)]);
    await rm(shows, { recursive: true });
    const gone = await scan([folder(shows)]);
    expect(gone.markedMissing).toBe(0);
    expect(gone.skippedFolders[0]).toMatchObject({ path: shows, reason: expect.stringContaining("ENOENT") });

    await mkdir(shows); // an unmounted drive's mount point: there, but empty
    const empty = await scan([folder(shows)]);
    expect(empty.markedMissing).toBe(0);
    expect(empty.skippedFolders[0]?.reason).toMatch(/empty/);
    expect(availabilityByEpisode()).toEqual({ 1: "available", 2: "available" });
  });
});
