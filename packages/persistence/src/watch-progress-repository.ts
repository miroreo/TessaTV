import type { WatchProgress, WatchProgressRepository } from "@tessatv/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { watchProgress } from "./schema.js";

function toDomain(row: typeof watchProgress.$inferSelect): WatchProgress {
  return {
    userId: row.userId,
    unitId: row.unitId,
    positionSeconds: row.positionSeconds,
    durationSeconds: row.durationSeconds,
    completed: row.completed,
    watchedAt: row.watchedAt,
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
      .values({ userId: progress.userId, unitId: progress.unitId, ...values, watchedAt: progress.watchedAt })
      .onConflictDoUpdate({
        target: [watchProgress.userId, watchProgress.unitId],
        // `greatest` ignores nulls, so a rewatch's save can't clear "watched".
        set: { ...values, watchedAt: sql`greatest(${watchProgress.watchedAt}, excluded.watched_at)` },
      });
  }

  async markWatched(userId: string, unitIds: readonly string[], at: Date): Promise<void> {
    if (unitIds.length === 0) return;
    const rows = unitIds.map((unitId, order) => {
      const when = new Date(at.getTime() + order);
      return { userId, unitId, positionSeconds: 0, durationSeconds: null, completed: true, watchedAt: when, updatedAt: when };
    });
    await this.db
      .insert(watchProgress)
      .values(rows)
      .onConflictDoUpdate({
        target: [watchProgress.userId, watchProgress.unitId],
        set: {
          // At the end, where it's known.
          positionSeconds: sql`coalesce(${watchProgress.durationSeconds}, ${watchProgress.positionSeconds})`,
          completed: true,
          watchedAt: sql`greatest(${watchProgress.watchedAt}, excluded.watched_at)`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  async markUnwatched(userId: string, unitIds: readonly string[]): Promise<void> {
    if (unitIds.length === 0) return;
    await this.db
      .update(watchProgress)
      .set({ positionSeconds: 0, completed: false, watchedAt: null })
      .where(and(eq(watchProgress.userId, userId), inArray(watchProgress.unitId, [...unitIds])));
  }

  async forgetPosition(userId: string, unitId: string): Promise<void> {
    await this.db
      .update(watchProgress)
      .set({ positionSeconds: 0, completed: false })
      .where(and(eq(watchProgress.userId, userId), eq(watchProgress.unitId, unitId)));
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
