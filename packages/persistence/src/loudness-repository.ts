import type { LoudnessMeasurement, LoudnessRepository } from "@tessatv/domain";
import { desc, eq, isNull } from "drizzle-orm";
import type { Database } from "./db.js";
import { audioLoudness, mediaFile } from "./schema.js";

export class DrizzleLoudnessRepository implements LoudnessRepository {
  constructor(private readonly db: Database) {}

  async get(mediaFileId: string): Promise<LoudnessMeasurement | null> {
    const [row] = await this.db.select().from(audioLoudness).where(eq(audioLoudness.mediaFileId, mediaFileId));
    return row ?? null;
  }

  async save(measurement: LoudnessMeasurement): Promise<void> {
    const { streamIndex, integratedLufs, truePeakDbtp, measuredAt, error } = measurement;
    await this.db
      .insert(audioLoudness)
      .values(measurement)
      .onConflictDoUpdate({
        target: audioLoudness.mediaFileId,
        set: { streamIndex, integratedLufs, truePeakDbtp, measuredAt, error },
      });
  }

  async listUnmeasured(limit: number): Promise<{ id: string; path: string }[]> {
    return this.db
      .select({ id: mediaFile.id, path: mediaFile.path })
      .from(mediaFile)
      .leftJoin(audioLoudness, eq(audioLoudness.mediaFileId, mediaFile.id))
      .where(isNull(audioLoudness.mediaFileId))
      .orderBy(desc(mediaFile.importedAt))
      .limit(limit);
  }
}
