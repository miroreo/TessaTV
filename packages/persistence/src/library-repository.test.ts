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
});
