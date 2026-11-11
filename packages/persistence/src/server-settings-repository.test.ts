import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { serverSetting } from "./schema.js";
import { DrizzleServerSettingsRepository } from "./server-settings-repository.js";

// Requires a running Postgres, like the other repository tests. Restores whatever settings
// the database had, since this is the same table the dev server uses.
const db: Database = createDatabase(process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv");
const settings = new DrizzleServerSettingsRepository(db);
let saved: (typeof serverSetting.$inferSelect)[] = [];
beforeAll(async () => {
  saved = await db.select().from(serverSetting);
  await db.delete(serverSetting);
});
afterAll(async () => {
  await db.delete(serverSetting);
  if (saved.length) await db.insert(serverSetting).values(saved);
});

describe("DrizzleServerSettingsRepository", () => {
  it("defaults, saves, and saves a cap back to none", async () => {
    expect(await settings.get()).toEqual({ maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false });
    expect(await settings.update({ maxStreamHeight: 1080 })).toEqual({ maxStreamHeight: 1080, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false });
    expect(await settings.update({ maxStreamHeight: null })).toEqual({ maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false });
    expect(await settings.update({})).toEqual({ maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false });
  });

  it("saves the file health check on or off, and ignores a stored value that isn't a boolean", async () => {
    expect((await settings.update({ fileHealthCheck: false })).fileHealthCheck).toBe(false);
    expect((await settings.get()).fileHealthCheck).toBe(false);
    expect((await settings.update({ fileHealthCheck: true })).fileHealthCheck).toBe(true);
    expect((await settings.update({ fileHealthFullSpeed: true })).fileHealthFullSpeed).toBe(true);
    expect((await settings.update({ fileHealthFullSpeed: false })).fileHealthFullSpeed).toBe(false);
    await db.insert(serverSetting).values({ key: "fileHealthCheck", value: "yes" }).onConflictDoUpdate({ target: serverSetting.key, set: { value: "yes" } });
    expect((await settings.get()).fileHealthCheck).toBe(true);
    await db.delete(serverSetting);
  });

  it("ignores a stored value that's no longer allowed", async () => {
    await db.insert(serverSetting).values({ key: "maxStreamHeight", value: 999 }).onConflictDoUpdate({ target: serverSetting.key, set: { value: 999 } });
    await db.insert(serverSetting).values({ key: "retired", value: true });
    expect(await settings.get()).toEqual({ maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false });
  });
});
