import type { LibraryNode } from "@tessatv/domain";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { DrizzleLibraryRepository } from "./library-repository.js";
import { libraryNode } from "./schema.js";

// Requires a running Postgres (the same one `db:migrate` targets) — unlike mappers.test.ts,
// this exercises the actual query builder, which a pure in-memory fake can't: an in-memory
// fake that does `this.nodes.set(node.id, node)` persists every field by construction, so
// it can never catch the real `updateNode` silently omitting a field from its SQL `SET`
// clause (as happened with `parentId` — found live, not by any prior test, when a
// series-merge reparent silently no-op'd against the real database).
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const repository = new DrizzleLibraryRepository(db);

function fakeNode(overrides: Partial<LibraryNode> & { id: string }): LibraryNode {
  const now = new Date();
  return {
    mediaType: "series",
    kind: "collection",
    parentId: null,
    title: overrides.id,
    sortTitle: overrides.id,
    sourceKey: overrides.id,
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const createdIds: string[] = [];

afterEach(async () => {
  const ids = createdIds.splice(0);
  if (ids.length > 0) {
    await db.delete(libraryNode).where(inArray(libraryNode.id, ids));
  }
});

describe("DrizzleLibraryRepository.updateNode", () => {
  it("persists a parentId change — the exact bug that shipped once", async () => {
    const parentA = fakeNode({ id: randomUUID() });
    const parentB = fakeNode({ id: randomUUID() });
    const child = fakeNode({ id: randomUUID(), parentId: parentA.id });
    await repository.createNode(parentA);
    await repository.createNode(parentB);
    await repository.createNode(child);
    createdIds.push(parentA.id, parentB.id, child.id);

    await repository.updateNode({ ...child, parentId: parentB.id });

    const reloaded = await repository.getNode(child.id);
    expect(reloaded?.parentId).toBe(parentB.id);
  });

  it("persists source aliases — the same class of bug, for the field series merging adds", async () => {
    const node = fakeNode({ id: randomUUID() });
    await repository.createNode(node);
    createdIds.push(node.id);
    expect((await repository.getNode(node.id))?.sourceAliases).toEqual([]);

    await repository.updateNode({ ...node, sourceAliases: ["Show.Name", "Show Name (US)"] });
    expect((await repository.getNode(node.id))?.sourceAliases).toEqual(["Show.Name", "Show Name (US)"]);
  });
});

describe("DrizzleLibraryRepository listings", () => {
  it("listChildren returns each child with only its own external ids", async () => {
    const parent = fakeNode({ id: randomUUID() });
    const withIds = fakeNode({ id: randomUUID(), parentId: parent.id });
    const without = fakeNode({ id: randomUUID(), parentId: parent.id });
    const elsewhere = fakeNode({ id: randomUUID() });
    const tvdb = (entityId: string, providerId: string) => ({ provider: "tvdb", entityType: "library_node" as const, entityId, providerId });
    for (const node of [parent, without]) await repository.createNode(node);
    await repository.createNode({ ...withIds, externalIds: [tvdb(withIds.id, "42")] });
    await repository.createNode({ ...elsewhere, externalIds: [tvdb(elsewhere.id, "99")] });
    createdIds.push(parent.id, withIds.id, without.id, elsewhere.id);

    const children = await repository.listChildren(parent.id);

    expect(children.map((child) => [child.id, child.externalIds.map((id) => id.providerId)]).sort()).toEqual(
      [[withIds.id, ["42"]], [without.id, []]].sort(),
    );
  });

  it("listUnits returns each unit with its own external ids", async () => {
    const node = fakeNode({ id: randomUUID(), kind: "leaf", mediaType: "movie" });
    await repository.createNode(node);
    createdIds.push(node.id);
    const now = new Date();
    const unit = (id: string, providerId: string | null) => ({
      id,
      libraryNodeId: node.id,
      mediaType: "movie",
      title: id,
      sequence: { path: [] },
      externalIds: providerId ? [{ provider: "tmdb", entityType: "unit" as const, entityId: id, providerId }] : [],
      availability: "missing" as const,
      mediaFileId: null,
      createdAt: now,
      updatedAt: now,
    });
    const [a, b] = [unit(randomUUID(), "7"), unit(randomUUID(), null)];
    await repository.createUnit(a);
    await repository.createUnit(b);

    const units = await repository.listUnits(node.id);

    expect(units.map((entry) => [entry.id, entry.externalIds.map((id) => id.providerId)]).sort()).toEqual([[a.id, ["7"]], [b.id, []]].sort());
  });
});
