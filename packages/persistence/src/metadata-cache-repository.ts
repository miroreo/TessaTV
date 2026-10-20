import type { MetadataCacheEntry, MetadataCacheRepository } from "@tessatv/domain";
import { and, eq } from "drizzle-orm";
import type { Database } from "./db.js";
import { metadataCache } from "./schema.js";

export class DrizzleMetadataCacheRepository implements MetadataCacheRepository {
  constructor(private readonly db: Database) {}

  async get(provider: string, externalId: string): Promise<MetadataCacheEntry | null> {
    const [row] = await this.db
      .select()
      .from(metadataCache)
      .where(and(eq(metadataCache.provider, provider), eq(metadataCache.externalId, externalId)));

    return row ? { provider: row.provider, externalId: row.externalId, payload: row.payload, fetchedAt: row.fetchedAt } : null;
  }

  async set(entry: MetadataCacheEntry): Promise<void> {
    await this.db
      .insert(metadataCache)
      .values({ provider: entry.provider, externalId: entry.externalId, payload: entry.payload, fetchedAt: entry.fetchedAt })
      .onConflictDoUpdate({
        target: [metadataCache.provider, metadataCache.externalId],
        set: { payload: entry.payload, fetchedAt: entry.fetchedAt },
      });
  }
}
