import type { JobRepository } from "@tessatv/domain";
import type { JobDefinition } from "./job-definition.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Postgres-backed polling scheduler: `recordRun` persists `next_run_at` so it survives a
 * process restart, and a job whose handler throws is recorded with `lastError` rather than
 * crashing the runner or blocking every other registered job from running on this tick —
 * the same per-item isolation lesson learned the hard way with the auto-identify sweep.
 */
export class JobRunner {
  private readonly definitions = new Map<string, JobDefinition>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repository: JobRepository,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  register(definition: JobDefinition): void {
    this.definitions.set(definition.name, definition);
  }

  async start(): Promise<void> {
    for (const definition of this.definitions.values()) {
      await this.repository.ensureJob(definition.name, new Date());
    }
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // tick() already isolates and records per-job errors; a rejection here would only
        // come from the repository call itself, which the next tick will simply retry.
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs every currently-due job once. Exposed directly so tests don't need to fake timers. */
  async tick(): Promise<void> {
    const due = await this.repository.getDueJobs(new Date());

    for (const job of due) {
      const definition = this.definitions.get(job.name);
      if (!definition) continue;

      const ranAt = new Date();
      let error: string | null = null;
      try {
        await definition.handler();
      } catch (handlerError) {
        error = handlerError instanceof Error ? handlerError.message : String(handlerError);
      }

      await this.repository.recordRun(definition.name, {
        ranAt,
        nextRunAt: new Date(ranAt.getTime() + definition.intervalMs),
        error,
      });
    }
  }
}
