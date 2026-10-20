import type { ScheduledJobState } from "../job.js";

export interface JobRunResult {
  readonly ranAt: Date;
  readonly nextRunAt: Date;
  readonly error: string | null;
}

export interface JobRepository {
  /** No-op if a row for this name already exists (e.g. from a previous process run). */
  ensureJob(name: string, initialNextRunAt: Date): Promise<void>;
  getDueJobs(now: Date): Promise<ScheduledJobState[]>;
  recordRun(name: string, result: JobRunResult): Promise<void>;
}
