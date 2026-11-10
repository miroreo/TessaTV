import type { WatchProgress, WatchProgressRepository } from "@tessatv/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "./db.js";
import { watchProgress } from "./schema.js";

function toDomain(row: typeof watchProgress.$inferSelect): WatchProgress {
  return {
    userId: row.userId,
    unitId: row.unitId,
    positionSeconds: row.positionSeconds,
    durationSeconds: row.durationSeconds,
    completed: row.completed,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleWatchProgressRepository implements WatchProgressRepository {
  constructor(private readonly db: Database) {}

  async get(userId: string, unitId: string): Promise<WatchProgress | null> {
    const [row] = await this.db
      .select()
      .from(watchProgress)
      .where(and(eq(watchProgress.userId, userId), eq(watchProgress.unitId, unitId)));
    return row ? toDomain(row) : null;
  }

  async save(progress: WatchProgress): Promise<void> {
    const values = {
      positionSeconds: progress.positionSeconds,
      durationSeconds: progress.durationSeconds,
      completed: progress.completed,
      updatedAt: progress.updatedAt,
    };
    await this.db
      .insert(watchProgress)
      .values({ userId: progress.userId, unitId: progress.unitId, ...values })
      .onConflictDoUpdate({ target: [watchProgress.userId, watchProgress.unitId], set: values });
  }

  async listRecent(userId: string, limit: number): Promise<WatchProgress[]> {
    const rows = await this.db
      .select()
      .from(watchProgress)
      .where(eq(watchProgress.userId, userId))
      .orderBy(desc(watchProgress.updatedAt))
      .limit(limit);
    return rows.map(toDomain);
  }

  async listForUnits(userId: string, unitIds: readonly string[]): Promise<WatchProgress[]> {
    if (unitIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(watchProgress)
      .where(and(eq(watchProgress.userId, userId), inArray(watchProgress.unitId, [...unitIds])));
    return rows.map(toDomain);
  }
}
