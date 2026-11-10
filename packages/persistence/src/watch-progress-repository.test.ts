import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { DrizzleLibraryRepository } from "./library-repository.js";
import { appUser, libraryNode, unit, watchProgress } from "./schema.js";
import { DrizzleWatchProgressRepository } from "./watch-progress-repository.js";

// Requires a running Postgres, like the other repository tests: the upsert and the
// cascades are database behavior.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const progress = new DrizzleWatchProgressRepository(db);
const library = new DrizzleLibraryRepository(db);

const userIds: string[] = [];
const nodeIds: string[] = [];
afterAll(async () => {
  // Watch history blocks deleting its user or unit, so it has to go first.
  if (userIds.length) await db.delete(watchProgress).where(inArray(watchProgress.userId, userIds));
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
    const base = { userId, unitId: unitIds[0], durationSeconds: 100, completed: false, watchedAt: null };
    await progress.save({ ...base, positionSeconds: 10, updatedAt: new Date(1_000) });
    await progress.save({ ...base, positionSeconds: 95, completed: true, watchedAt: new Date(2_000), updatedAt: new Date(2_000) });
    expect(await progress.get(userId, unitIds[0])).toEqual({
      ...base, positionSeconds: 95, completed: true, watchedAt: new Date(2_000), updatedAt: new Date(2_000),
    });
  });

  it("keeps a unit watched through a rewatch, and only moves watchedAt forward", async () => {
    const { userId, unitIds } = await fixture();
    const base = { userId, unitId: unitIds[0], durationSeconds: 100 };
    await progress.save({ ...base, positionSeconds: 95, completed: true, watchedAt: new Date(2_000), updatedAt: new Date(2_000) });
    await progress.save({ ...base, positionSeconds: 5, completed: false, watchedAt: null, updatedAt: new Date(3_000) });
    expect(await progress.get(userId, unitIds[0])).toMatchObject({ positionSeconds: 5, completed: false, watchedAt: new Date(2_000) });
    await progress.save({ ...base, positionSeconds: 99, completed: true, watchedAt: new Date(1_000), updatedAt: new Date(4_000) });
    expect((await progress.get(userId, unitIds[0]))?.watchedAt).toEqual(new Date(2_000));
    await progress.save({ ...base, positionSeconds: 99, completed: true, watchedAt: new Date(5_000), updatedAt: new Date(5_000) });
    expect((await progress.get(userId, unitIds[0]))?.watchedAt).toEqual(new Date(5_000));
  });

  it("lists most recent first, and by unit", async () => {
    const { userId, unitIds } = await fixture();
    const unwatched = { durationSeconds: null, completed: false, watchedAt: null };
    await progress.save({ userId, unitId: unitIds[0], positionSeconds: 1, ...unwatched, updatedAt: new Date(1_000) });
    await progress.save({ userId, unitId: unitIds[1], positionSeconds: 2, ...unwatched, updatedAt: new Date(2_000) });
    expect((await progress.listRecent(userId, 10)).map((row) => row.unitId)).toEqual([unitIds[1], unitIds[0]]);
    expect(await progress.listRecent(userId, 1)).toHaveLength(1);
    expect((await progress.listForUnits(userId, [unitIds[0]])).map((row) => row.positionSeconds)).toEqual([1]);
    expect(await progress.listForUnits(userId, [])).toEqual([]);
  });

  it("refuses to delete a unit, its node or its user while watch history exists", async () => {
    const { userId, unitIds } = await fixture();
    await progress.save({
      userId, unitId: unitIds[0], positionSeconds: 5, durationSeconds: null, completed: false, watchedAt: null, updatedAt: new Date(),
    });
    await expect(db.delete(unit).where(eq(unit.id, unitIds[0]))).rejects.toThrow();
    await expect(library.deleteNode(nodeIds.at(-1)!)).rejects.toThrow();
    await expect(db.delete(appUser).where(eq(appUser.id, userId))).rejects.toThrow();
    expect(await progress.get(userId, unitIds[0])).not.toBeNull();
  });

  it("moves history between units, merging where a user has both", async () => {
    const { userId, unitIds } = await fixture();
    const other = (await fixture()).userId;
    const row = (unitId: string, positionSeconds: number, completed: boolean, at: number, user = userId) =>
      progress.save({
        userId: user, unitId, positionSeconds, durationSeconds: 100, completed,
        watchedAt: completed ? new Date(at) : null, updatedAt: new Date(at),
      });
    await row(unitIds[0], 40, false, 2_000); // newer position, not watched
    await row(unitIds[1], 95, true, 1_000); // older, but watched
    await row(unitIds[0], 10, false, 3_000, other); // only on the source

    await library.moveWatchProgress(unitIds[0], unitIds[1]);

    expect(await progress.get(userId, unitIds[1])).toEqual({
      userId, unitId: unitIds[1], positionSeconds: 40, durationSeconds: 100, completed: false,
      watchedAt: new Date(1_000), updatedAt: new Date(2_000),
    });
    expect((await progress.get(other, unitIds[1]))?.positionSeconds).toBe(10);
    expect(await progress.get(userId, unitIds[0])).toBeNull();
    expect(await progress.get(other, unitIds[0])).toBeNull();
  });

  it("marks watched (in order, at the end where known), unwatched, and forgets a position", async () => {
    const { userId, unitIds } = await fixture();
    await progress.save({ userId, unitId: unitIds[0], positionSeconds: 40, durationSeconds: 100, completed: false, watchedAt: null, updatedAt: new Date(1_000) });
    await progress.markWatched(userId, unitIds, new Date(5_000));
    expect(await progress.get(userId, unitIds[0])).toMatchObject({ positionSeconds: 100, completed: true, watchedAt: new Date(5_000), updatedAt: new Date(5_000) });
    expect(await progress.get(userId, unitIds[1])).toMatchObject({ positionSeconds: 0, completed: true, watchedAt: new Date(5_001), updatedAt: new Date(5_001) });

    await progress.markUnwatched(userId, [unitIds[1]]);
    expect(await progress.get(userId, unitIds[1])).toMatchObject({ positionSeconds: 0, completed: false, watchedAt: null, updatedAt: new Date(5_001) });

    await progress.save({ userId, unitId: unitIds[1], positionSeconds: 50, durationSeconds: 100, completed: false, watchedAt: null, updatedAt: new Date(6_000) });
    await progress.forgetPosition(userId, unitIds[1]);
    await progress.forgetPosition(userId, unitIds[0]);
    expect(await progress.get(userId, unitIds[1])).toMatchObject({ positionSeconds: 0, completed: false, updatedAt: new Date(6_000) });
    // Forgetting where you were doesn't forget that you watched it.
    expect(await progress.get(userId, unitIds[0])).toMatchObject({ positionSeconds: 0, completed: false, watchedAt: new Date(5_000) });
  });
});
