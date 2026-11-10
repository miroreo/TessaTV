import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HardwareAccel } from "./hardware-accel/hardware-accel.js";
import { SoftwareAccel } from "./hardware-accel/software.js";
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
  /** How long a session gets to produce its first segment before it counts as failed. */
  readonly playlistTimeoutMs?: number;
  /**
   * Retries a hardware transcode that fails to start on the CPU instead, and keeps using the
   * CPU for that transcode's later seeks. Defaults to software; `null` disables the retry.
   */
  readonly fallbackAccel?: HardwareAccel | null;
  /** Called when a transcode falls back, e.g. to log why the GPU path failed. */
  readonly onFallback?: (error: Error, plan: HlsPlaybackPlan) => void;
  /** Test seams. */
  readonly startSession?: typeof startTranscodeSession;
  readonly now?: () => number;
}

interface Entry {
  readonly id: string;
  readonly plan: HlsPlaybackPlan;
  session: TranscodeSession;
  accel: HardwareAccel;
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
    const { session, accel } = await this.launch(id, 0, plan, startTimeSeconds, this.options.accel);
    const entry: Entry = { id, plan, startTimeSeconds, session, accel, lastAccessMs: this.now(), generation: 0 };
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
    const { session, accel } = await this.launch(id, entry.generation, entry.plan, seconds, entry.accel);
    entry.session = session;
    entry.accel = accel;
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

  /**
   * Starts ffmpeg and waits for its first segment, so callers always get a playable session.
   * A hardware failure (a driver bug, a file the GPU chokes on) is retried on the CPU rather
   * than surfacing as a playback error.
   */
  private async launch(
    id: string,
    generation: number,
    plan: HlsPlaybackPlan,
    startTimeSeconds: number,
    accel: HardwareAccel,
  ): Promise<{ session: TranscodeSession; accel: HardwareAccel }> {
    const fallback = this.options.fallbackAccel === undefined ? new SoftwareAccel() : this.options.fallbackAccel;
    const session = await this.spawn(id, generation, plan, startTimeSeconds, accel);
    try {
      await session.waitForPlaylist(this.options.playlistTimeoutMs ?? 60_000);
      return { session, accel };
    } catch (error) {
      await session.dispose();
      // Only a video re-encode uses the accel; a remux failing on the CPU would fail again.
      if (!fallback || accel.kind === fallback.kind || plan.video?.kind !== "transcode") throw error;
      this.options.onFallback?.(error as Error, plan);
      const retry = await this.spawn(id, generation, plan, startTimeSeconds, fallback);
      try {
        await retry.waitForPlaylist(this.options.playlistTimeoutMs ?? 60_000);
      } catch (retryError) {
        await retry.dispose();
        throw retryError;
      }
      return { session: retry, accel: fallback };
    }
  }

  private spawn(id: string, generation: number, plan: HlsPlaybackPlan, startTimeSeconds: number, accel: HardwareAccel) {
    return this.startSession(plan, {
      accel,
      directory: join(this.sessionDirectory(id), String(generation)),
      startTimeSeconds,
      ...(this.options.ffmpegPath ? { ffmpegPath: this.options.ffmpegPath } : {}),
      ...(this.options.segmentSeconds ? { segmentSeconds: this.options.segmentSeconds } : {}),
    });
  }
}
