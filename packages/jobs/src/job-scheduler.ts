import { PgBoss } from "pg-boss";
import type { JobDefinition } from "./job-definition.js";

export interface JobSchedulerOptions {
  /** pg-boss reports background errors (lost connection, maintenance) here. */
  readonly onError: (error: Error) => void;
}

/**
 * Recurring jobs on pg-boss: its own `pgboss` schema holds the schedules, so they survive
 * restarts, and a `singleton` queue keeps two server processes from running one job at once.
 * A failing handler is recorded (and retried) by pg-boss without affecting other jobs.
 */
export class JobScheduler {
  private readonly definitions: JobDefinition[] = [];
  private readonly boss: PgBoss;

  constructor(connectionString: string, options: JobSchedulerOptions) {
    this.boss = new PgBoss(connectionString);
    this.boss.on("error", options.onError);
  }

  register(definition: JobDefinition): void {
    this.definitions.push(definition);
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const { name, cron, handler } of this.definitions) {
      await this.boss.createQueue(name, { policy: "singleton" });
      // `once`: a run missed while the server was down happens on the next start, once.
      await this.boss.schedule(name, cron, null, { missed: "once" });
      await this.boss.work(name, async () => handler());
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true });
  }
}
