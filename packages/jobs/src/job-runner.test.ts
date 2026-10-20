import type { JobRepository, JobRunResult, ScheduledJobState } from "@tessatv/domain";
import { describe, expect, it, vi } from "vitest";
import { JobRunner } from "./job-runner.js";

class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, ScheduledJobState>();

  async ensureJob(name: string, initialNextRunAt: Date) {
    if (!this.jobs.has(name)) {
      this.jobs.set(name, { name, nextRunAt: initialNextRunAt, lastRunAt: null, lastError: null });
    }
  }

  async getDueJobs(now: Date) {
    return Array.from(this.jobs.values()).filter((job) => job.nextRunAt <= now);
  }

  async recordRun(name: string, result: JobRunResult) {
    this.jobs.set(name, { name, nextRunAt: result.nextRunAt, lastRunAt: result.ranAt, lastError: result.error });
  }

  get(name: string): ScheduledJobState | undefined {
    return this.jobs.get(name);
  }
}

describe("JobRunner", () => {
  it("runs a due job once per tick and schedules the next run", async () => {
    const repository = new InMemoryJobRepository();
    const runner = new JobRunner(repository);
    const handler = vi.fn().mockResolvedValue(undefined);
    runner.register({ name: "test-job", intervalMs: 1000, handler });

    await repository.ensureJob("test-job", new Date(0)); // due immediately
    await runner.tick();

    expect(handler).toHaveBeenCalledTimes(1);
    const state = repository.get("test-job");
    expect(state?.lastError).toBeNull();
    expect(state?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not run a job before its next_run_at", async () => {
    const repository = new InMemoryJobRepository();
    const runner = new JobRunner(repository);
    const handler = vi.fn();
    runner.register({ name: "future-job", intervalMs: 1000, handler });

    await repository.ensureJob("future-job", new Date(Date.now() + 60_000));
    await runner.tick();

    expect(handler).not.toHaveBeenCalled();
  });

  it("records a handler error without throwing, and still updates next_run_at", async () => {
    const repository = new InMemoryJobRepository();
    const runner = new JobRunner(repository);
    runner.register({
      name: "failing-job",
      intervalMs: 1000,
      handler: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await repository.ensureJob("failing-job", new Date(0));
    await expect(runner.tick()).resolves.toBeUndefined();

    const state = repository.get("failing-job");
    expect(state?.lastError).toBe("boom");
    expect(state?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("one job failing does not block another due job from running in the same tick", async () => {
    const repository = new InMemoryJobRepository();
    const runner = new JobRunner(repository);
    const goodHandler = vi.fn().mockResolvedValue(undefined);
    runner.register({ name: "bad-job", intervalMs: 1000, handler: vi.fn().mockRejectedValue(new Error("boom")) });
    runner.register({ name: "good-job", intervalMs: 1000, handler: goodHandler });

    await repository.ensureJob("bad-job", new Date(0));
    await repository.ensureJob("good-job", new Date(0));
    await runner.tick();

    expect(goodHandler).toHaveBeenCalledTimes(1);
    expect(repository.get("good-job")?.lastError).toBeNull();
  });

  it("start() seeds missing jobs and runs an immediate tick", async () => {
    const repository = new InMemoryJobRepository();
    const runner = new JobRunner(repository);
    const handler = vi.fn().mockResolvedValue(undefined);
    runner.register({ name: "new-job", intervalMs: 1000, handler });

    await runner.start();
    runner.stop();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
