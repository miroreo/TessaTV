import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHeapProfiler, MemoryDiagnostics, memoryReport, type HeapProfiler, type MemoryReport } from "./diagnostics.js";

const report = (heapUsedMb: number): MemoryReport => ({
  heapUsedMb, heapTotalMb: heapUsedMb, heapLimitMb: 4096, rssMb: heapUsedMb + 100, externalMb: 1, arrayBuffersMb: 0, spaces: [],
});

describe("MemoryDiagnostics", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tessatv-diagnostics-test-"));
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  function setup(heapMb: { value: number }) {
    const reports: MemoryReport[] = [];
    const captures: { profile: string; snapshot: string }[] = [];
    const snapshots: string[] = [];
    const profiler: HeapProfiler = { start: async () => {}, profile: async () => '{"head":{}}', stop: async () => {} };
    const diagnostics = new MemoryDiagnostics({
      directory,
      captureAtMb: 500,
      onReport: (r) => reports.push(r),
      onCapture: (files) => captures.push(files),
      report: () => report(heapMb.value),
      profiler,
      writeSnapshot: (path) => (snapshots.push(path), path),
      now: () => new Date("2026-11-11T09:00:00.000Z"),
    });
    return { diagnostics, reports, captures, snapshots };
  }

  it("reports every tick, and captures a profile and a snapshot once, the first time the heap passes the threshold", async () => {
    const heap = { value: 100 };
    const { diagnostics, reports, captures, snapshots } = setup(heap);
    await diagnostics.tick();
    expect(captures).toHaveLength(0);

    heap.value = 600;
    await diagnostics.tick();
    heap.value = 900;
    await diagnostics.tick();

    expect(reports.map((r) => r.heapUsedMb)).toEqual([100, 600, 900]);
    expect(captures).toHaveLength(1);
    expect(snapshots).toEqual([join(directory, "heap-2026-11-11T09-00-00-000Z.heapsnapshot")]);
    expect(captures[0]!.profile).toBe(join(directory, "heap-2026-11-11T09-00-00-000Z.heapprofile"));
    expect(await readFile(captures[0]!.profile, "utf8")).toBe('{"head":{}}');
  });

  it("keeps going, and says so, when a capture fails", async () => {
    const errors: Error[] = [];
    const diagnostics = new MemoryDiagnostics({
      directory,
      captureAtMb: 1,
      onReport: () => {},
      onError: (error) => errors.push(error),
      report: () => report(10),
      profiler: { start: async () => {}, profile: async () => { throw new Error("profiler gone"); }, stop: async () => {} },
    });
    await diagnostics.tick();
    expect(errors.map((e) => e.message)).toEqual(["profiler gone"]);
  });
});

describe("against the real V8 profiler", () => {
  it("reports the heap, and a profile names the code that allocated what's still held", async () => {
    const report = memoryReport();
    expect(report.heapUsedMb).toBeGreaterThan(0);
    expect(report.heapLimitMb).toBeGreaterThan(report.heapUsedMb);
    expect(report.spaces.map((space) => space.name)).toContain("old_space");

    const profiler = createHeapProfiler();
    await profiler.start();
    const held: unknown[] = [];
    // A deliberate leak: allocated in a named function and never released.
    function leakySiteForDiagnosticsTest() {
      for (let i = 0; i < 20_000; i += 1) held.push({ index: i, payload: new Array(64).fill(i) });
    }
    leakySiteForDiagnosticsTest();
    const profile = JSON.parse(await profiler.profile()) as { head: unknown };
    await profiler.stop();
    expect(JSON.stringify(profile)).toContain("leakySiteForDiagnosticsTest");
    expect(held.length).toBe(20_000);
  });

  it("writes a heap snapshot file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tessatv-snapshot-test-"));
    try {
      const diagnostics = new MemoryDiagnostics({ directory, captureAtMb: 1_000_000, onReport: () => {} });
      const path = diagnostics.captureSnapshot();
      expect(path.endsWith(".heapsnapshot")).toBe(true);
      expect((await readdir(directory)).some((name) => name.endsWith(".heapsnapshot"))).toBe(true);
      expect((await readFile(path, "utf8")).startsWith('{"snapshot"')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
