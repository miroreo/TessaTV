import type { ImportedWatchProgress, WatchProgress, WatchProgressRepository } from "@tessatv/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { heldWatchHistory, watchProgress } from "./schema.js";

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

/** Takes the incoming value only when the incoming row is newer than the stored one. */
function newerWins(column: { name: string }, table: string) {
  return sql.raw(`case when excluded.updated_at > ${table}.updated_at then excluded.${column.name} else ${table}.${column.name} end`);
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

  async importHistory(userId: string, entries: readonly ImportedWatchProgress[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db
      .insert(watchProgress)
      .values(entries.map((entry) => ({ userId, ...entry })))
      .onConflictDoUpdate({
        target: [watchProgress.userId, watchProgress.unitId],
        set: {
          positionSeconds: newerWins(watchProgress.positionSeconds, "watch_progress"),
          durationSeconds: sql`coalesce(${newerWins(watchProgress.durationSeconds, "watch_progress")}, ${watchProgress.durationSeconds}, excluded.duration_seconds)`,
          completed: newerWins(watchProgress.completed, "watch_progress"),
          watchedAt: sql`greatest(${watchProgress.watchedAt}, excluded.watched_at)`,
          updatedAt: sql`greatest(${watchProgress.updatedAt}, excluded.updated_at)`,
        },
      });
  }

  async holdHistory(username: string, entries: readonly ImportedWatchProgress[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db
      .insert(heldWatchHistory)
      .values(entries.map((entry) => ({ usernameLower: username.toLowerCase(), ...entry })))
      .onConflictDoUpdate({
        target: [heldWatchHistory.usernameLower, heldWatchHistory.unitId],
        set: {
          positionSeconds: newerWins(heldWatchHistory.positionSeconds, "held_watch_history"),
          durationSeconds: sql`coalesce(${newerWins(heldWatchHistory.durationSeconds, "held_watch_history")}, ${heldWatchHistory.durationSeconds}, excluded.duration_seconds)`,
          completed: newerWins(heldWatchHistory.completed, "held_watch_history"),
          watchedAt: sql`greatest(${heldWatchHistory.watchedAt}, excluded.watched_at)`,
          updatedAt: sql`greatest(${heldWatchHistory.updatedAt}, excluded.updated_at)`,
        },
      });
  }

  async claimHeldHistory(username: string, userId: string): Promise<number> {
    const key = username.toLowerCase();
    return this.db.transaction(async (tx) => {
      const held = await tx.select().from(heldWatchHistory).where(eq(heldWatchHistory.usernameLower, key));
      if (held.length === 0) return 0;
      await new DrizzleWatchProgressRepository(tx as unknown as Database).importHistory(
        userId,
        held.map((row) => ({
          unitId: row.unitId,
          positionSeconds: row.positionSeconds,
          durationSeconds: row.durationSeconds,
          completed: row.completed,
          watchedAt: row.watchedAt,
          updatedAt: row.updatedAt,
        })),
      );
      await tx.delete(heldWatchHistory).where(eq(heldWatchHistory.usernameLower, key));
      return held.length;
    });
  }
}
