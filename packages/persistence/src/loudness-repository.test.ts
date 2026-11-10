import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { DrizzleLibraryRepository } from "./library-repository.js";
import { DrizzleLoudnessRepository } from "./loudness-repository.js";
import { libraryNode } from "./schema.js";

// Requires a running Postgres, like the other repository tests: the upsert and the
// "never measured" join are database behavior.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const loudness = new DrizzleLoudnessRepository(db);
const library = new DrizzleLibraryRepository(db);
const nodeIds: string[] = [];
afterAll(async () => {
  if (nodeIds.length) await db.delete(libraryNode).where(inArray(libraryNode.id, nodeIds));
});

async function mediaFile(importedAt: Date) {
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
    resolutionWidth: null, resolutionHeight: null, sizeBytes: 1, checksum: null, importedAt,
  });
  return fileId;
}

describe("DrizzleLoudnessRepository", () => {
  it("lists only unmeasured files, newest first, and upserts measurements", async () => {
    const future = Date.now() + 365 * 24 * 3600 * 1000; // newest in the table, whatever else is there
    const older = await mediaFile(new Date(future));
    const newer = await mediaFile(new Date(future + 1000));
    expect((await loudness.listUnmeasured(2)).map((file) => file.id)).toEqual([newer, older]);

    const measurement = { mediaFileId: newer, streamIndex: 1, integratedLufs: -30, truePeakDbtp: -2, measuredAt: new Date(1000), error: null };
    await loudness.save(measurement);
    await loudness.save({ ...measurement, integratedLufs: -31 });
    expect(await loudness.get(newer)).toEqual({ ...measurement, integratedLufs: -31 });
    expect((await loudness.listUnmeasured(1)).map((file) => file.id)).toEqual([older]);
  });
});
