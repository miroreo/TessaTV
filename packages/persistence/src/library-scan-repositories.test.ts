import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { DrizzleLibraryFolderRepository, DrizzleMediaAvailabilityRepository } from "./library-scan-repositories.js";
import { DrizzleLibraryRepository } from "./library-repository.js";
import { libraryFolder, libraryNode } from "./schema.js";

// Requires a running Postgres, like the other repository tests: the LIKE prefix match and
// the recursive root query are database behavior.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const folders = new DrizzleLibraryFolderRepository(db);
const availability = new DrizzleMediaAvailabilityRepository(db);
const library = new DrizzleLibraryRepository(db);
const nodeIds: string[] = [];
const folderIds: string[] = [];
afterAll(async () => {
  if (nodeIds.length) await db.delete(libraryNode).where(inArray(libraryNode.id, nodeIds));
  if (folderIds.length) await db.delete(libraryFolder).where(inArray(libraryFolder.id, folderIds));
});

const now = new Date();
async function seriesWithEpisode(root: string, filePath: string) {
  const ids = { series: randomUUID(), season: randomUUID(), leaf: randomUUID(), unit: randomUUID(), file: randomUUID() };
  nodeIds.push(ids.series, ids.season, ids.leaf);
  const node = (id: string, parentId: string | null, kind: "collection" | "leaf") => ({
    id, parentId, kind, mediaType: "series", title: root, sortTitle: root, sourceKey: id, externalIds: [],
    monitored: true, qualityProfileId: null, createdAt: now, updatedAt: now,
  });
  await library.createNode(node(ids.series, null, "collection"));
  await library.createNode(node(ids.season, ids.series, "collection"));
  await library.createNode(node(ids.leaf, ids.season, "leaf"));
  await library.createUnit({
    id: ids.unit, libraryNodeId: ids.leaf, mediaType: "series", title: "E", sequence: { path: [1, 1] }, externalIds: [],
    availability: "missing", mediaFileId: null, createdAt: now, updatedAt: now,
  });
  await library.createMediaFile({
    id: ids.file, unitId: ids.unit, path: filePath, container: "mkv", videoCodec: null, audioCodec: null,
    resolutionWidth: null, resolutionHeight: null, sizeBytes: 1, checksum: null, importedAt: now,
  });
  await library.updateUnit({ ...(await library.getUnit(ids.unit))!, mediaFileId: ids.file, availability: "available" });
  return ids;
}

describe("library scan repositories", () => {
  it("matches files by folder prefix literally, not as a LIKE pattern or a sibling folder", async () => {
    const base = `/scan-test-${randomUUID()}`;
    const inside = await seriesWithEpisode("A", `${base}/100%_shows/Show/S01E01.mkv`);
    await seriesWithEpisode("B", `${base}/100%_showsX/Show/S01E01.mkv`);
    await seriesWithEpisode("C", `${base}/1000_shows/Show/S01E01.mkv`);
    const found = await availability.listFilesUnder(`${base}/100%_shows`);
    expect(found).toEqual([{ unitId: inside.unit, path: `${base}/100%_shows/Show/S01E01.mkv`, availability: "available" }]);
  });

  it("hides a root once its only unit is marked missing, and brings it back", async () => {
    const ids = await seriesWithEpisode("D", `/scan-test-${randomUUID()}/Show/S01E01.mkv`);
    expect((await availability.listRootsWithPlayableUnits()).has(ids.series)).toBe(true);
    await availability.setAvailability([ids.unit], "missing");
    expect((await availability.listRootsWithPlayableUnits()).has(ids.series)).toBe(false);
    await availability.setAvailability([ids.unit], "available");
    expect((await availability.listRootsWithPlayableUnits()).has(ids.series)).toBe(true);
  });

  it("stores folders and rejects a duplicate path", async () => {
    const folder = { id: randomUUID(), mediaType: "movie" as const, path: `/scan-test-${randomUUID()}`, createdAt: now };
    folderIds.push(folder.id);
    await folders.add(folder);
    expect((await folders.list()).find((entry) => entry.id === folder.id)).toEqual(folder);
    await expect(folders.add({ ...folder, id: randomUUID() })).rejects.toThrow();
    await folders.remove(folder.id);
    expect((await folders.list()).some((entry) => entry.id === folder.id)).toBe(false);
  });
});
