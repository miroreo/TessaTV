/** Persisted scheduling state for one named job, independent of what the job actually does. */
export interface ScheduledJobState {
  readonly name: string;
  readonly nextRunAt: Date;
  readonly lastRunAt: Date | null;
  readonly lastError: string | null;
}
