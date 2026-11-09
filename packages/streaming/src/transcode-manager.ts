import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HardwareAccel } from "./hardware-accel/hardware-accel.js";
import type { HlsPlaybackPlan } from "./playback-plan.js";
import { startTranscodeSession, type TranscodeSession } from "./transcode-session.js";

/** Thrown when starting a transcode would exceed `maxConcurrent`; maps naturally to a 503. */
export class TranscodeCapacityError extends Error {
  constructor(maxConcurrent: number) {
    super(`Already running the maximum of ${maxConcurrent} transcodes`);
    this.name = "TranscodeCapacityError";
  }
}

export interface ManagedTranscode {
  /** Stable across seeks, unlike the underlying session. */
  readonly id: string;
  readonly plan: HlsPlaybackPlan;
  readonly session: TranscodeSession;
  /** Where in the source the current session's output begins. */
  readonly startTimeSeconds: number;
}

export interface TranscodeManagerOptions {
  /** Owned by the manager, except that only its own `session-*` directories are ever deleted. */
  readonly directory: string;
  readonly accel: HardwareAccel;
  readonly maxConcurrent?: number;
  readonly idleTimeoutMs?: number;
  readonly ffmpegPath?: string;
  readonly segmentSeconds?: number;
  /** Test seams. */
  readonly startSession?: typeof startTranscodeSession;
  readonly now?: () => number;
}

interface Entry {
  readonly id: string;
  readonly plan: HlsPlaybackPlan;
  session: TranscodeSession;
  startTimeSeconds: number;
  lastAccessMs: number;
  generation: number;
}

const SESSION_DIRECTORY_PREFIX = "session-";
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Owns every running transcode: caps how many run at once, reaps ones no client is
 * fetching anymore, and restarts ffmpeg when a client seeks somewhere not yet transcoded.
 */
export class TranscodeManager {
  private readonly entries = new Map<string, Entry>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly maxConcurrent: number;
  private readonly idleTimeoutMs: number;
  private readonly startSession: typeof startTranscodeSession;
  private readonly now: () => number;

  constructor(private readonly options: TranscodeManagerOptions) {
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.startSession = options.startSession ?? startTranscodeSession;
    this.now = options.now ?? Date.now;
  }

  /** Clears output orphaned by a previous crash and begins reaping idle transcodes. */
  async start(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    const children = await readdir(this.options.directory);
    await Promise.all(
      children
        .filter((name) => name.startsWith(SESSION_DIRECTORY_PREFIX))
        .map((name) => rm(join(this.options.directory, name), { recursive: true, force: true })),
    );
    this.sweepTimer = setInterval(() => void this.reapIdle(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async begin(plan: HlsPlaybackPlan, startTimeSeconds = 0): Promise<ManagedTranscode> {
    await this.reapIdle();
    this.assertCapacity();
    const id = randomUUID();
    const entry: Entry = {
      id,
      plan,
      startTimeSeconds,
      session: await this.spawn(id, 0, plan, startTimeSeconds),
      lastAccessMs: this.now(),
      generation: 0,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** Looks up a transcode and marks it in use; every segment request should go through this. */
  touch(id: string): ManagedTranscode | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.lastAccessMs = this.now();
    return entry;
  }

  /** Keeps the session if `seconds` is already transcoded; otherwise restarts ffmpeg there. */
  async seek(id: string, seconds: number): Promise<ManagedTranscode | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.lastAccessMs = this.now();
    const transcodedUntil = entry.startTimeSeconds + entry.session.progress.outTimeSeconds;
    if (seconds >= entry.startTimeSeconds && seconds <= transcodedUntil) return entry;

    await entry.session.dispose();
    entry.generation += 1;
    entry.session = await this.spawn(id, entry.generation, entry.plan, seconds);
    entry.startTimeSeconds = seconds;
    return entry;
  }

  async end(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    await entry.session.dispose();
    await rm(this.sessionDirectory(id), { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.all([...this.entries.keys()].map((id) => this.end(id)));
  }

  private async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const idle = [...this.entries.values()].filter((entry) => entry.lastAccessMs < cutoff);
    await Promise.all(idle.map((entry) => this.end(entry.id)));
  }

  /** Finished transcodes just hold files, so only live ffmpeg processes count. */
  private assertCapacity(): void {
    const running = [...this.entries.values()].filter((entry) => entry.session.state === "running").length;
    if (running >= this.maxConcurrent) throw new TranscodeCapacityError(this.maxConcurrent);
  }

  private sessionDirectory(id: string): string {
    return join(this.options.directory, `${SESSION_DIRECTORY_PREFIX}${id}`);
  }

  private spawn(id: string, generation: number, plan: HlsPlaybackPlan, startTimeSeconds: number) {
    return this.startSession(plan, {
      accel: this.options.accel,
      directory: join(this.sessionDirectory(id), String(generation)),
      startTimeSeconds,
      ...(this.options.ffmpegPath ? { ffmpegPath: this.options.ffmpegPath } : {}),
      ...(this.options.segmentSeconds ? { segmentSeconds: this.options.segmentSeconds } : {}),
    });
  }
}
