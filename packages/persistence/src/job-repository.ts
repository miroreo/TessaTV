import type { JobRepository, JobRunResult, ScheduledJobState } from "@tessatv/domain";
import { eq, lte } from "drizzle-orm";
import type { Database } from "./db.js";
import { scheduledJob } from "./schema.js";

export class DrizzleJobRepository implements JobRepository {
  constructor(private readonly db: Database) {}

  async ensureJob(name: string, initialNextRunAt: Date): Promise<void> {
    await this.db.insert(scheduledJob).values({ name, nextRunAt: initialNextRunAt }).onConflictDoNothing();
  }

  async getDueJobs(now: Date): Promise<ScheduledJobState[]> {
    const rows = await this.db.select().from(scheduledJob).where(lte(scheduledJob.nextRunAt, now));
    return rows.map((row) => ({
      name: row.name,
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      lastError: row.lastError,
    }));
  }

  async recordRun(name: string, result: JobRunResult): Promise<void> {
    await this.db
      .update(scheduledJob)
      .set({ nextRunAt: result.nextRunAt, lastRunAt: result.ranAt, lastError: result.error })
      .where(eq(scheduledJob.name, name));
  }
}
