import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildTranscodeArgs, PLAYLIST_FILENAME, type HlsOutputOptions } from "./ffmpeg-args.js";
import type { HardwareAccel } from "./hardware-accel/hardware-accel.js";
import type { PlaybackPlan } from "./playback-plan.js";
import { spawnProcess, type ProcessSpawner, type SpawnedProcess } from "./process.js";

export type TranscodeState = "running" | "completed" | "failed" | "stopped";

export interface TranscodeProgress {
  /** Position in the output stream, in seconds (offset by `startTimeSeconds` from the source). */
  readonly outTimeSeconds: number;
  /** Encode speed relative to realtime (2 = twice as fast as playback). */
  readonly speed: number | null;
}

export interface TranscodeResult {
  readonly state: Exclude<TranscodeState, "running">;
  /** ffmpeg's stderr tail when it failed. */
  readonly error: string | null;
}

export interface TranscodeSessionOptions extends HlsOutputOptions {
  readonly accel: HardwareAccel;
  readonly ffmpegPath?: string;
  readonly spawner?: ProcessSpawner;
  /** How long `stop()` waits after SIGTERM before SIGKILL. */
  readonly killTimeoutMs?: number;
}

const STDERR_TAIL_BYTES = 4096;

/** One running ffmpeg process writing HLS for one playback plan. */
export class TranscodeSession {
  readonly id = randomUUID();
  readonly playlistPath: string;
  /** Settles when ffmpeg exits, however it exits. Never rejects. */
  readonly done: Promise<TranscodeResult>;

  private currentState: TranscodeState = "running";
  private latestProgress: TranscodeProgress = { outTimeSeconds: 0, speed: null };
  private readonly progressListeners = new Set<(progress: TranscodeProgress) => void>();
  private stopRequested = false;
  private stderrTail = "";

  constructor(
    private readonly process: SpawnedProcess,
    readonly outputDirectory: string,
    private readonly killTimeoutMs: number,
  ) {
    this.playlistPath = join(outputDirectory, PLAYLIST_FILENAME);
    this.process.stdout?.setEncoding("utf8");
    this.process.stdout?.on("data", (chunk: string) => this.consumeProgress(chunk));
    this.process.stderr?.setEncoding("utf8");
    this.process.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    this.done = new Promise((resolve) => {
      const finish = (state: TranscodeResult["state"], error: string | null) => {
        if (this.currentState !== "running") return;
        this.currentState = state;
        resolve({ state, error });
      };
      this.process.on("error", (error) => finish("failed", error.message));
      this.process.on("exit", (code) => {
        if (this.stopRequested) finish("stopped", null);
        else if (code === 0) finish("completed", null);
        else finish("failed", this.stderrTail.trim() || `ffmpeg exited with code ${code}`);
      });
    });
  }

  get state(): TranscodeState {
    return this.currentState;
  }

  get progress(): TranscodeProgress {
    return this.latestProgress;
  }

  onProgress(listener: (progress: TranscodeProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /**
   * Resolves once ffmpeg has written the playlist (i.e. the first segment is ready to
   * serve). Rejects if ffmpeg exits first without producing one, or on timeout.
   */
  async waitForPlaylist(timeoutMs = 30_000, pollMs = 100): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await access(this.playlistPath).then(() => true, () => false)) return this.playlistPath;
      if (this.currentState !== "running") {
        const result = await this.done;
        throw new Error(`Transcode ${result.state} before producing a playlist${result.error ? `: ${result.error}` : ""}`);
      }
      if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${this.playlistPath}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Asks ffmpeg to finish cleanly (SIGTERM), escalating to SIGKILL if it doesn't. */
  async stop(): Promise<TranscodeResult> {
    if (this.currentState === "running") {
      this.stopRequested = true;
      this.process.kill("SIGTERM");
      const timer = setTimeout(() => this.process.kill("SIGKILL"), this.killTimeoutMs);
      await this.done;
      clearTimeout(timer);
    }
    return this.done;
  }

  /** Stops ffmpeg and deletes everything it wrote. */
  async dispose(): Promise<void> {
    await this.stop();
    await rm(this.outputDirectory, { recursive: true, force: true });
  }

  private progressBuffer = "";
  private pendingProgress: { outTimeSeconds?: number; speed?: number | null } = {};

  /** Parses ffmpeg's `-progress` key=value blocks, each terminated by a `progress=` line. */
  private consumeProgress(chunk: string) {
    this.progressBuffer += chunk;
    const lines = this.progressBuffer.split("\n");
    this.progressBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === "out_time_us" || key === "out_time_ms") {
        // Both keys are microseconds (`out_time_ms` is a long-standing ffmpeg misnomer).
        const micros = Number(value);
        if (Number.isFinite(micros)) this.pendingProgress.outTimeSeconds = micros / 1_000_000;
      } else if (key === "speed") {
        const speed = Number.parseFloat(value);
        this.pendingProgress.speed = Number.isFinite(speed) ? speed : null;
      } else if (key === "progress") {
        this.latestProgress = {
          outTimeSeconds: this.pendingProgress.outTimeSeconds ?? this.latestProgress.outTimeSeconds,
          speed: this.pendingProgress.speed !== undefined ? this.pendingProgress.speed : this.latestProgress.speed,
        };
        this.pendingProgress = {};
        for (const listener of this.progressListeners) listener(this.latestProgress);
      }
    }
  }
}

/** Starts ffmpeg for an HLS plan. Direct-play plans need no session — serve the file. */
export async function startTranscodeSession(
  plan: PlaybackPlan,
  options: TranscodeSessionOptions,
): Promise<TranscodeSession> {
  if (plan.mode === "direct-play") {
    throw new Error("Direct-play plans don't need a transcode session; serve the file directly");
  }
  await mkdir(options.directory, { recursive: true });
  const args = buildTranscodeArgs(plan, options.accel, options);
  const spawner = options.spawner ?? spawnProcess;
  return new TranscodeSession(spawner(options.ffmpegPath ?? "ffmpeg", args), options.directory, options.killTimeoutMs ?? 5_000);
}
