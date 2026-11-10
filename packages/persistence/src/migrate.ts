import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./db.js";

/** Shipped next to `dist/`, so this resolves the same from source, the build, and Docker. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies pending migrations at startup, so deploying a new version needs no manual step.
 * Uses the same bookkeeping table as `drizzle-kit migrate`, so the two are interchangeable.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
