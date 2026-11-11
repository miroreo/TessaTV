import type { FileHealth, FileHealthRepository } from "@tessatv/domain";
import { asc, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { fileHealth, mediaFile } from "./schema.js";

export class DrizzleFileHealthRepository implements FileHealthRepository {
  constructor(private readonly db: Database) {}

  async get(mediaFileId: string): Promise<FileHealth | null> {
    const [row] = await this.db.select().from(fileHealth).where(eq(fileHealth.mediaFileId, mediaFileId));
    return row ?? null;
  }

  async save(health: FileHealth): Promise<void> {
    const { checkedAt, sizeBytes, error } = health;
    await this.db
      .insert(fileHealth)
      .values(health)
      .onConflictDoUpdate({ target: fileHealth.mediaFileId, set: { checkedAt, sizeBytes, error } });
  }

  async listDue(limit: number, staleBefore: Date): Promise<{ id: string; path: string; sizeBytes: number }[]> {
    // Never checked (0), then changed since the check (1), then merely stale (2). Within a
    // group the newest imports come first, and stale ones the longest-unchecked first.
    const group = sql`case when ${fileHealth.mediaFileId} is null then 0 when ${fileHealth.sizeBytes} <> ${mediaFile.sizeBytes} then 1 else 2 end`;
    return this.db
      .select({ id: mediaFile.id, path: mediaFile.path, sizeBytes: mediaFile.sizeBytes })
      .from(mediaFile)
      .leftJoin(fileHealth, eq(fileHealth.mediaFileId, mediaFile.id))
      .where(or(isNull(fileHealth.mediaFileId), ne(fileHealth.sizeBytes, mediaFile.sizeBytes), lt(fileHealth.checkedAt, staleBefore)))
      .orderBy(asc(group), asc(fileHealth.checkedAt), desc(mediaFile.importedAt))
      .limit(limit);
  }
}
