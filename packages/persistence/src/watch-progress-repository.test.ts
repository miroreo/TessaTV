import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { DrizzleLibraryRepository } from "./library-repository.js";
import { appUser, libraryNode } from "./schema.js";
import { DrizzleWatchProgressRepository } from "./watch-progress-repository.js";

// Requires a running Postgres, like the other repository tests: the upsert and the
// cascades are database behavior.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const progress = new DrizzleWatchProgressRepository(db);
const library = new DrizzleLibraryRepository(db);

const userIds: string[] = [];
const nodeIds: string[] = [];
afterAll(async () => {
  if (nodeIds.length) await db.delete(libraryNode).where(inArray(libraryNode.id, nodeIds));
  if (userIds.length) await db.delete(appUser).where(inArray(appUser.id, userIds));
});

async function fixture() {
  const now = new Date();
  const userId = randomUUID();
  userIds.push(userId);
  await db.insert(appUser).values({ id: userId, username: `progress-${userId}`, passwordHash: "x" });
  const nodeId = randomUUID();
  nodeIds.push(nodeId);
  await library.createNode({
    id: nodeId, mediaType: "movie", kind: "leaf", parentId: null, title: "T", sortTitle: "t", sourceKey: nodeId,
    externalIds: [], monitored: true, qualityProfileId: null, createdAt: now, updatedAt: now,
  });
  const unitIds = [randomUUID(), randomUUID()];
  for (const id of unitIds) {
    await library.createUnit({
      id, libraryNodeId: nodeId, mediaType: "movie", title: "T", sequence: { path: [] }, externalIds: [],
      availability: "available", mediaFileId: null, createdAt: now, updatedAt: now,
    });
  }
  return { userId, unitIds: unitIds as [string, string] };
}

describe("DrizzleWatchProgressRepository", () => {
  it("overwrites the one row per user and unit", async () => {
    const { userId, unitIds } = await fixture();
    const base = { userId, unitId: unitIds[0], durationSeconds: 100, completed: false };
    await progress.save({ ...base, positionSeconds: 10, updatedAt: new Date(1_000) });
    await progress.save({ ...base, positionSeconds: 95, completed: true, updatedAt: new Date(2_000) });
    expect(await progress.get(userId, unitIds[0])).toEqual({ ...base, positionSeconds: 95, completed: true, updatedAt: new Date(2_000) });
  });

  it("lists most recent first, and by unit", async () => {
    const { userId, unitIds } = await fixture();
    await progress.save({ userId, unitId: unitIds[0], positionSeconds: 1, durationSeconds: null, completed: false, updatedAt: new Date(1_000) });
    await progress.save({ userId, unitId: unitIds[1], positionSeconds: 2, durationSeconds: null, completed: false, updatedAt: new Date(2_000) });
    expect((await progress.listRecent(userId, 10)).map((row) => row.unitId)).toEqual([unitIds[1], unitIds[0]]);
    expect(await progress.listRecent(userId, 1)).toHaveLength(1);
    expect((await progress.listForUnits(userId, [unitIds[0]])).map((row) => row.positionSeconds)).toEqual([1]);
    expect(await progress.listForUnits(userId, [])).toEqual([]);
  });
});
