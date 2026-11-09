import { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it } from "vitest";
import { JobScheduler } from "./job-scheduler.js";

// Requires a running Postgres, like persistence's repository tests: pg-boss is the thing
// under test here, so faking it would test nothing.
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://tessatv:tessatv@localhost:5432/tessatv";

describe("JobScheduler", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it("runs a registered job when it's sent, and keeps running after a handler throws", async () => {
    const name = `test-${Date.now()}`;
    const errors: Error[] = [];
    const scheduler = new JobScheduler(DATABASE_URL, { onError: (error) => errors.push(error) });
    let runs = 0;
    const ran = new Promise<void>((resolve) => {
      scheduler.register({
        name,
        cron: "0 4 * * *",
        handler: async () => {
          runs += 1;
          if (runs === 1) throw new Error("first run fails");
          resolve();
        },
      });
    });
    await scheduler.start();
    cleanup.push(() => scheduler.stop());

    const sender = new PgBoss(DATABASE_URL);
    await sender.start();
    cleanup.push(async () => {
      await sender.deleteQueue(name);
      await sender.stop();
    });
    await sender.send(name);
    await sender.send(name);

    await ran;
    expect(runs).toBe(2);
    expect(errors).toEqual([]);
  }, 30_000);
});
