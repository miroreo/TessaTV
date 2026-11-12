import { randomUUID } from "node:crypto";
import type { SubtitleFile } from "@tessatv/domain";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { DrizzleLibraryRepository } from "./library-repository.js";
import { libraryNode } from "./schema.js";
import { DrizzleSubtitleRepository } from "./subtitle-repository.js";

// Requires a running Postgres, like the other repository tests: the "wanting" query is database behavior.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const subtitles = new DrizzleSubtitleRepository(db);
const library = new DrizzleLibraryRepository(db);
const nodeIds: string[] = [];
afterAll(async () => {
  if (nodeIds.length) await db.delete(libraryNode).where(inArray(libraryNode.id, nodeIds));
});

async function video(importedAt: Date, availability: "available" | "missing" = "available") {
  const nodeId = randomUUID();
  nodeIds.push(nodeId);
  const unitId = randomUUID();
  const mediaFileId = randomUUID();
  const now = new Date();
  await library.createNode({
    id: nodeId, mediaType: "movie", kind: "leaf", parentId: null, title: "T", sortTitle: "t", sourceKey: nodeId,
    externalIds: [], monitored: true, qualityProfileId: null, createdAt: now, updatedAt: now,
  });
  await library.createUnit({
    id: unitId, libraryNodeId: nodeId, mediaType: "movie", title: "T", sequence: { path: [] }, externalIds: [],
    availability, mediaFileId: null, createdAt: now, updatedAt: now,
  });
  await library.createMediaFile({
    id: mediaFileId, unitId, path: `/media/${mediaFileId}.mkv`, container: "mkv", videoCodec: null, audioCodec: null,
    resolutionWidth: null, resolutionHeight: null, sizeBytes: 1, checksum: null, importedAt,
  });
  await library.updateUnit({ id: unitId, libraryNodeId: nodeId, mediaType: "movie", title: "T", sequence: { path: [] }, externalIds: [], availability, mediaFileId, createdAt: now, updatedAt: now });
  return { unitId, mediaFileId, path: `/media/${mediaFileId}.mkv` };
}

function file(v: { unitId: string; mediaFileId: string; path: string }, overrides: Partial<SubtitleFile> = {}): SubtitleFile {
  return {
    id: randomUUID(), unitId: v.unitId, mediaFileId: v.mediaFileId, language: "en", forced: false, hearingImpaired: false,
    source: "downloaded", provider: "opensubtitles", providerId: "1", score: 70, path: v.path.replace(".mkv", ".en.srt"), format: "srt",
    createdAt: new Date(), ...overrides,
  };
}

describe("DrizzleSubtitleRepository", () => {
  it("lists units still wanting a slot, newest first, and stops once it is filled", async () => {
    const future = Date.now() + 365 * 24 * 3600 * 1000;
    const older = await video(new Date(future));
    const newer = await video(new Date(future + 1000));
    const missing = await video(new Date(future + 2000), "missing");
    const slot = { language: "en", forced: false };
    const now = new Date();

    const ids = async () => (await subtitles.listWanting(slot, now, 3)).map((wanted) => wanted.unitId);
    expect(await ids()).toEqual([newer.unitId, older.unitId]);
    expect(await ids()).not.toContain(missing.unitId);

    await subtitles.add(file(newer));
    expect(await ids()).toEqual([older.unitId]);
    // A forced subtitle is a different slot, and a regional file fills the plain-language slot.
    expect((await subtitles.listWanting({ language: "en", forced: true }, now, 3)).map((w) => w.unitId)).toContain(newer.unitId);
    await subtitles.add(file(older, { language: "en-GB" }));
    expect(await ids()).toEqual([]);
  });

  it("lists every playable file and every recorded subtitle", async () => {
    const v = await video(new Date());
    const gone = await video(new Date(), "missing");
    await subtitles.add(file(v));
    expect((await subtitles.listPlayableFiles()).map((w) => w.unitId)).toContain(v.unitId);
    expect((await subtitles.listPlayableFiles()).map((w) => w.unitId)).not.toContain(gone.unitId);
    expect((await subtitles.listAll()).map((f) => f.unitId)).toContain(v.unitId);
  });

  it("holds a slot back until its retry time, and clears the wait when the slot is filled", async () => {
    const v = await video(new Date(Date.now() + 366 * 24 * 3600 * 1000));
    const slot = { language: "fr", forced: false };
    const now = new Date();
    const record = { unitId: v.unitId, slotKey: "fr", outcome: "none" as const, attempts: 1, attemptedAt: now, retryAfter: new Date(now.getTime() + 60_000) };

    await subtitles.saveSearchRecord(record);
    await subtitles.saveSearchRecord({ ...record, attempts: 2 });
    expect(await subtitles.getSearchRecord(v.unitId, "fr")).toEqual({ ...record, attempts: 2 });
    expect((await subtitles.listWanting(slot, now, 5)).map((w) => w.unitId)).not.toContain(v.unitId);
    expect((await subtitles.listWanting(slot, new Date(now.getTime() + 120_000), 5)).map((w) => w.unitId)).toContain(v.unitId);

    await subtitles.add(file(v, { language: "fr", path: v.path.replace(".mkv", ".fr.srt") }));
    expect(await subtitles.getSearchRecord(v.unitId, "fr")).toBeNull();
  });

  it("replaces the row when the same path is downloaded again, and remembers the blacklist", async () => {
    const v = await video(new Date());
    await subtitles.add(file(v, { score: 61 }));
    await subtitles.add(file(v, { score: 90, providerId: "2" }));
    const rows = await subtitles.listForUnit(v.unitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ score: 90, providerId: "2" });
    expect(await subtitles.get(rows[0]!.id)).not.toBeNull();

    await subtitles.blacklist(v.unitId, "opensubtitles", "1");
    await subtitles.blacklist(v.unitId, "opensubtitles", "1");
    expect(await subtitles.listBlacklisted(v.unitId)).toEqual([{ provider: "opensubtitles", providerId: "1" }]);

    await subtitles.remove(rows[0]!.id);
    expect(await subtitles.listForUnit(v.unitId)).toEqual([]);
  });
});
