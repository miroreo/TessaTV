import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { DrizzleFileHealthRepository } from "./file-health-repository.js";
import { DrizzleLibraryRepository } from "./library-repository.js";
import { libraryNode } from "./schema.js";

// Requires a running Postgres, like the other repository tests: the "due" ordering is a
// database query.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const health = new DrizzleFileHealthRepository(db);
const library = new DrizzleLibraryRepository(db);
const nodeIds: string[] = [];
afterAll(async () => {
  if (nodeIds.length) await db.delete(libraryNode).where(inArray(libraryNode.id, nodeIds));
});

async function mediaFile(importedAt: Date, sizeBytes = 1) {
  const nodeId = randomUUID();
  nodeIds.push(nodeId);
  const unitId = randomUUID();
  const fileId = randomUUID();
  const now = new Date();
  await library.createNode({
    id: nodeId, mediaType: "movie", kind: "leaf", parentId: null, title: "T", sortTitle: "t", sourceKey: nodeId,
    externalIds: [], monitored: true, qualityProfileId: null, createdAt: now, updatedAt: now,
  });
  await library.createUnit({
    id: unitId, libraryNodeId: nodeId, mediaType: "movie", title: "T", sequence: { path: [] }, externalIds: [],
    availability: "available", mediaFileId: null, createdAt: now, updatedAt: now,
  });
  await library.createMediaFile({
    id: fileId, unitId, path: `/media/${fileId}.mkv`, container: "mkv", videoCodec: null, audioCodec: null,
    resolutionWidth: null, resolutionHeight: null, sizeBytes, checksum: null, importedAt,
  });
  return fileId;
}

describe("DrizzleFileHealthRepository", () => {
  it("upserts a file's result", async () => {
    const id = await mediaFile(new Date());
    const result = { mediaFileId: id, checkedAt: new Date(1000), sizeBytes: 1, error: null, severity: "clean" as const, videoErrors: 0, audioErrors: 0 };
    await health.save(result);
    await health.save({ ...result, error: "bad frame", severity: "minor", videoErrors: 2, audioErrors: 1 });
    expect(await health.get(id)).toEqual({ ...result, error: "bad frame", severity: "minor", videoErrors: 2, audioErrors: 1 });
  });

  it("lists never-checked files first (newest import first), then changed ones, then stale ones", async () => {
    // Newer than real data but older than the loudness test's files, which assume they're the newest.
    const future = Date.now() + 300 * 24 * 3600 * 1000;
    const staleBefore = new Date(future);
    const old = new Date(future - 1000);
    const [freshOld, freshNew, changed, stale, clean] = [
      await mediaFile(new Date(future + 1000)),
      await mediaFile(new Date(future + 2000)),
      await mediaFile(new Date(future + 3000), 50),
      await mediaFile(new Date(future + 4000)),
      await mediaFile(new Date(future + 5000)),
    ];
    await health.save({ mediaFileId: changed, checkedAt: new Date(future + 10), sizeBytes: 49, error: null, severity: "clean", videoErrors: 0, audioErrors: 0 });
    await health.save({ mediaFileId: stale, checkedAt: old, sizeBytes: 1, error: null, severity: "clean", videoErrors: 0, audioErrors: 0 });
    await health.save({ mediaFileId: clean, checkedAt: new Date(future + 10), sizeBytes: 1, error: null, severity: "clean", videoErrors: 0, audioErrors: 0 });

    const due = await health.listDue(100_000, staleBefore);
    const ours: string[] = [freshNew, freshOld, changed, stale, clean];
    expect(due.map((file) => file.id).filter((id) => ours.includes(id))).toEqual([freshNew, freshOld, changed, stale]);
    expect(due.find((file) => file.id === changed)?.sizeBytes).toBe(50);
  });

  it("counts clean, minor, major and due files, and lists the flagged ones major first, then newest check first", async () => {
    const future = Date.now() + 200 * 24 * 3600 * 1000;
    const staleBefore = new Date(future);
    const [clean, minorNewer, majorOlder, minorOlder, unchecked] = [
      await mediaFile(new Date(future)),
      await mediaFile(new Date(future)),
      await mediaFile(new Date(future)),
      await mediaFile(new Date(future)),
      await mediaFile(new Date(future)),
    ];
    const base = { sizeBytes: 1, severity: "minor" as const, videoErrors: 1, audioErrors: 0 };
    await health.save({ mediaFileId: clean, checkedAt: new Date(future + 10), sizeBytes: 1, error: null, severity: "clean", videoErrors: 0, audioErrors: 0 });
    await health.save({ ...base, mediaFileId: minorOlder, checkedAt: new Date(future + 20), error: "bad frame" });
    await health.save({ ...base, mediaFileId: minorNewer, checkedAt: new Date(future + 30), error: "bad packet", videoErrors: 0, audioErrors: 4 });
    await health.save({ ...base, mediaFileId: majorOlder, checkedAt: new Date(future + 15), error: "exited", severity: "major", videoErrors: 30 });

    // Other test files add and remove files in the same table at the same time, so only
    // lower bounds hold: our five files, four checked (one clean, two minor, one major), one due.
    const summary = await health.summary(staleBefore);
    expect(summary.total).toBeGreaterThanOrEqual(5);
    expect(summary.clean).toBeGreaterThanOrEqual(1);
    expect(summary.minor).toBeGreaterThanOrEqual(2);
    expect(summary.major).toBeGreaterThanOrEqual(1);
    expect(summary.due).toBeGreaterThanOrEqual(1);
    expect(summary.clean + summary.minor + summary.major).toBeLessThanOrEqual(summary.total);
    expect(unchecked).toBeDefined();

    const ours: string[] = [minorOlder, minorNewer, majorOlder];
    const flagged = (await health.listFlagged(100_000)).filter((file) => ours.includes(file.mediaFileId));
    expect(flagged.map((file) => [file.mediaFileId, file.severity, file.error])).toEqual([
      [majorOlder, "major", "exited"],
      [minorNewer, "minor", "bad packet"],
      [minorOlder, "minor", "bad frame"],
    ]);
    expect(flagged[1]).toMatchObject({ path: `/media/${minorNewer}.mkv`, videoErrors: 0, audioErrors: 4 });
  });
});
