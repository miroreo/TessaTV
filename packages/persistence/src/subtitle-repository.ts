import type { SubtitleFile, SubtitleRepository, SubtitleSearchRecord, SubtitleSlot, WantedSubtitle } from "@tessatv/domain";
import { subtitleSlotKey } from "@tessatv/domain";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { subtitleBlacklist, subtitleFile, subtitleSearch } from "./schema.js";

function toFile(row: typeof subtitleFile.$inferSelect): SubtitleFile {
  return { ...row, source: row.source as SubtitleFile["source"] };
}

export class DrizzleSubtitleRepository implements SubtitleRepository {
  constructor(private readonly db: Database) {}

  async listForUnit(unitId: string): Promise<SubtitleFile[]> {
    const rows = await this.db.select().from(subtitleFile).where(eq(subtitleFile.unitId, unitId));
    return rows.map(toFile);
  }

  async get(id: string): Promise<SubtitleFile | null> {
    const [row] = await this.db.select().from(subtitleFile).where(eq(subtitleFile.id, id));
    return row ? toFile(row) : null;
  }

  async add(file: SubtitleFile): Promise<void> {
    const { language, forced, hearingImpaired, source, provider, providerId, score, format, mediaFileId, unitId, createdAt } = file;
    const replaceable = { language, forced, hearingImpaired, source, provider, providerId, score, format, mediaFileId, unitId, createdAt };
    await this.db.transaction(async (tx) => {
      // Replaces the row for the same path, so downloading over a file doesn't pile up rows.
      await tx.insert(subtitleFile).values(file).onConflictDoUpdate({ target: subtitleFile.path, set: replaceable });
      // The slot this fills (a regional file fills the plain-language slot too) is no longer waiting on a retry.
      await tx.execute(sql`
        delete from subtitle_search
        where unit_id = ${file.unitId}
          and split_part(split_part(slot_key, '.', 1), '-', 1) = ${file.language.split("-")[0]!}
          and (slot_key like '%.forced') = ${file.forced}
      `);
    });
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(subtitleFile).where(eq(subtitleFile.id, id));
  }

  async listWanting(slot: SubtitleSlot, now: Date, limit: number): Promise<WantedSubtitle[]> {
    // A regional file (pt-BR) fills a plain slot (pt), so a language match is by its first part.
    const result = await this.db.execute<{ unit_id: string; media_file_id: string; path: string }>(sql`
      select u.id as unit_id, mf.id as media_file_id, mf.path as path
      from unit u
      join media_file mf on mf.id = u.media_file_id
      where u.availability = 'available'
        and not exists (
          select 1 from subtitle_file sf
          where sf.unit_id = u.id and sf.forced = ${slot.forced}
            and split_part(sf.language, '-', 1) = split_part(${slot.language}, '-', 1)
        )
        and not exists (
          select 1 from subtitle_search ss
          where ss.unit_id = u.id and ss.slot_key = ${subtitleSlotKey(slot)} and ss.retry_after > ${now}
        )
      order by mf.imported_at desc
      limit ${limit}
    `);
    return result.rows.map((row) => ({ unitId: row.unit_id, mediaFileId: row.media_file_id, videoPath: row.path }));
  }

  async getSearchRecord(unitId: string, slotKey: string): Promise<SubtitleSearchRecord | null> {
    const [row] = await this.db
      .select()
      .from(subtitleSearch)
      .where(and(eq(subtitleSearch.unitId, unitId), eq(subtitleSearch.slotKey, slotKey)));
    return row ? { ...row, outcome: row.outcome as SubtitleSearchRecord["outcome"] } : null;
  }

  async saveSearchRecord(record: SubtitleSearchRecord): Promise<void> {
    await this.db
      .insert(subtitleSearch)
      .values(record)
      .onConflictDoUpdate({
        target: [subtitleSearch.unitId, subtitleSearch.slotKey],
        set: { outcome: record.outcome, attempts: record.attempts, attemptedAt: record.attemptedAt, retryAfter: record.retryAfter },
      });
  }

  async listBlacklisted(unitId: string): Promise<{ provider: string; providerId: string }[]> {
    return this.db
      .select({ provider: subtitleBlacklist.provider, providerId: subtitleBlacklist.providerId })
      .from(subtitleBlacklist)
      .where(eq(subtitleBlacklist.unitId, unitId));
  }

  async blacklist(unitId: string, provider: string, providerId: string): Promise<void> {
    await this.db.insert(subtitleBlacklist).values({ unitId, provider, providerId }).onConflictDoNothing();
  }
}
