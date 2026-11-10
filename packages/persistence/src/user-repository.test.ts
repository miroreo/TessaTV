import type { User } from "@tessatv/domain";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { appUser } from "./schema.js";
import { DrizzleAuthSessionRepository, DrizzleUserRepository } from "./user-repository.js";

// Requires a running Postgres, like library-repository.test.ts: the case-insensitive
// unique index and the advisory-locked first-user insert are database behavior a fake
// can't demonstrate.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const users = new DrizzleUserRepository(db);
const sessions = new DrizzleAuthSessionRepository(db);

// Evaluated before any test runs (top-level await isn't allowed inside `describe`).
const userTableEmpty = (await users.countUsers()) === 0;

const createdIds: string[] = [];
afterEach(async () => {
  const ids = createdIds.splice(0);
  if (ids.length > 0) await db.delete(appUser).where(inArray(appUser.id, ids));
});

function fakeUser(username: string): User {
  const id = randomUUID();
  createdIds.push(id);
  const now = new Date();
  return { id, username, passwordHash: "scrypt$test", oidcSubject: null, isAdmin: false, createdAt: now, updatedAt: now };
}

describe("DrizzleUserRepository", () => {
  it("looks up and enforces usernames case-insensitively", async () => {
    const name = `Test-${randomUUID()}`;
    const user = fakeUser(name);
    await users.createUser(user);
    expect((await users.getUserByUsername(name.toUpperCase()))?.id).toBe(user.id);
    await expect(users.createUser(fakeUser(name.toLowerCase()))).rejects.toThrow();
  });

  it("updates a user's password hash", async () => {
    const user = fakeUser(`rehash-${randomUUID()}`);
    await users.createUser(user);
    const later = new Date(user.updatedAt.getTime() + 60_000);
    await users.updatePasswordHash(user.id, "$argon2id$new", later);
    expect(await users.getUser(user.id)).toMatchObject({ passwordHash: "$argon2id$new", updatedAt: later });
  });

  it("round-trips sessions by token hash and cascades on user delete", async () => {
    const user = fakeUser(`session-${randomUUID()}`);
    await users.createUser(user);
    const now = new Date();
    const session = { id: randomUUID(), userId: user.id, tokenHash: randomUUID(), clientName: "test", createdAt: now, lastSeenAt: now };
    await sessions.createSession(session);
    expect(await sessions.getSessionByTokenHash(session.tokenHash)).toEqual(session);
    const later = new Date(now.getTime() + 60_000);
    await sessions.touchSession(session.id, later);
    expect((await sessions.getSessionByTokenHash(session.tokenHash))?.lastSeenAt).toEqual(later);
    await db.delete(appUser).where(inArray(appUser.id, [user.id]));
    expect(await sessions.getSessionByTokenHash(session.tokenHash)).toBeNull();
  });

  // Needs an empty user table, so it can't run against a dev database that has completed
  // first-run setup — it skips rather than deleting real accounts.
  it.skipIf(!userTableEmpty)("creates exactly one first user under concurrent setup", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => fakeUser(`first-${i}-${randomUUID()}`));
    const results = await Promise.all(candidates.map((user) => users.createFirstUser(user)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await users.countUsers()).toBe(1);
  });
});
