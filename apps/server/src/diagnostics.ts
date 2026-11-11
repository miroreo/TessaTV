import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { getHeapSpaceStatistics, getHeapStatistics, writeHeapSnapshot } from "node:v8";

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

export interface MemoryReport {
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  /** V8's old-space ceiling: the process dies with "heap out of memory" when it's reached. */
  readonly heapLimitMb: number;
  readonly rssMb: number;
  /** Buffers and native memory V8 doesn't count in the heap. */
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
  readonly spaces: readonly { readonly name: string; readonly usedMb: number }[];
}

export function memoryReport(): MemoryReport {
  const heap = getHeapStatistics();
  const usage = process.memoryUsage();
  return {
    heapUsedMb: mb(heap.used_heap_size),
    heapTotalMb: mb(heap.total_heap_size),
    heapLimitMb: mb(heap.heap_size_limit),
    rssMb: mb(usage.rss),
    externalMb: mb(usage.external),
    arrayBuffersMb: mb(usage.arrayBuffers),
    spaces: getHeapSpaceStatistics().map((space) => ({ name: space.space_name, usedMb: mb(space.space_used_size) })),
  };
}

/**
 * V8's sampling heap profiler: it records the call stack that allocated memory, and the
 * profile it hands back covers what is still alive, so it points at the code that created
 * whatever is piling up. The format is Chrome's `.heapprofile`, readable in DevTools.
 */
export interface HeapProfiler {
  start(): Promise<void>;
  /** The live allocations so far, as a `.heapprofile` JSON document. Sampling carries on. */
  profile(): Promise<string>;
  stop(): Promise<void>;
}

export function createHeapProfiler(): HeapProfiler {
  const session = new Session();
  let running = false;
  return {
    async start() {
      if (running) return;
      session.connect();
      await session.post("HeapProfiler.enable");
      // 64 KB between samples: cheap enough to leave on, fine-grained enough to see a leak.
      await session.post("HeapProfiler.startSampling", { samplingInterval: 65_536 });
      running = true;
    },
    async profile() {
      const { profile } = await session.post("HeapProfiler.getSamplingProfile");
      return JSON.stringify(profile);
    },
    async stop() {
      if (!running) return;
      await session.post("HeapProfiler.stopSampling");
      session.disconnect();
      running = false;
    },
  };
}

export interface MemoryDiagnosticsOptions {
  /** Where profiles and snapshots are written. Created if missing. */
  readonly directory: string;
  /** The first time the heap reaches this size, a profile and a snapshot are written, once. */
  readonly captureAtMb: number;
  readonly intervalMs?: number;
  /** Receives a report every interval, to log it. */
  readonly onReport: (report: MemoryReport) => void;
  readonly onCapture?: (files: { profile: string; snapshot: string }) => void;
  readonly onError?: (error: Error) => void;
  /** Test seams. */
  readonly report?: () => MemoryReport;
  readonly profiler?: HeapProfiler;
  readonly writeSnapshot?: (path: string) => string;
  readonly now?: () => Date;
}

/**
 * Opt-in tooling for finding a memory leak in the live process: logs heap numbers on a
 * timer, runs the sampling heap profiler, and captures a profile plus a full heap snapshot
 * (loadable in Chrome DevTools or analysed with memlab) when the heap first passes a
 * threshold — which is exactly when a leak is large enough to see clearly, and before the
 * process dies from it.
 */
export class MemoryDiagnostics {
  private timer: NodeJS.Timeout | null = null;
  private captured = false;
  private readonly report: () => MemoryReport;
  private readonly profiler: HeapProfiler;
  private readonly writeSnapshot: (path: string) => string;
  private readonly now: () => Date;

  constructor(private readonly options: MemoryDiagnosticsOptions) {
    this.report = options.report ?? memoryReport;
    this.profiler = options.profiler ?? createHeapProfiler();
    this.writeSnapshot = options.writeSnapshot ?? writeHeapSnapshot;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    await this.profiler.start();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.profiler.stop();
  }

  /** One interval: report the numbers, and capture if the heap has just passed the threshold. */
  async tick(): Promise<void> {
    const report = this.report();
    this.options.onReport(report);
    if (this.captured || report.heapUsedMb < this.options.captureAtMb) return;
    this.captured = true;
    try {
      // The profile first: it's quick, and the snapshot can take long enough to hit the limit.
      const profile = await this.captureProfile();
      const snapshot = this.captureSnapshot();
      this.options.onCapture?.({ profile, snapshot });
    } catch (error) {
      this.options.onError?.(error as Error);
    }
  }

  /** Writes the live-allocation profile to the directory and returns its path. */
  async captureProfile(): Promise<string> {
    const path = join(this.options.directory, `heap-${this.stamp()}.heapprofile`);
    await writeFile(path, await this.profiler.profile());
    return path;
  }

  /** Writes a full heap snapshot (blocks the event loop while it does) and returns its path. */
  captureSnapshot(): string {
    return this.writeSnapshot(join(this.options.directory, `heap-${this.stamp()}.heapsnapshot`));
  }

  private stamp(): string {
    return this.now().toISOString().replace(/[:.]/g, "-");
  }
}
