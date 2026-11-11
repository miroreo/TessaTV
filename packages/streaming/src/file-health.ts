import { access } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { FILE_HEALTH_RECHECK_DAYS, type FileHealthRepository } from "@tessatv/domain";
import { runCommand, type CommandRunner } from "./process.js";

export interface FileHealthCheckOptions {
  readonly ffmpegPath?: string;
  readonly runner?: CommandRunner;
  /** How fast ffmpeg may read the file, in multiples of realtime. */
  readonly readRate?: number;
  readonly signal?: AbortSignal;
  /** Gives up on a check that runs this long. */
  readonly timeoutMs?: number;
}

const DEFAULT_READ_RATE = 4;
const DEFAULT_CHECK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_ERROR_CHARS = 500;

/**
 * Decodes the first video and audio streams end to end on the CPU and returns what ffmpeg
 * complained about, or null when the file is clean. Deliberately software-only: a damaged
 * file can hang a GPU decoder, which is exactly what this exists to find out safely. Runs
 * at the lowest CPU priority, on one thread, throttled to `readRate`× realtime so a check
 * never gets in playback's way; a long film takes the better part of an hour.
 */
export async function checkFileHealth(path: string, options: FileHealthCheckOptions = {}): Promise<string | null> {
  const runner = options.runner ?? runCommand;
  const result = await runner(
    "nice",
    [
      "-n", "19",
      options.ffmpegPath ?? "ffmpeg",
      "-hide_banner", "-nostdin",
      "-v", "error",
      // Exit non-zero on a decode error, so mere warnings (odd timestamps, which plenty of
      // healthy files produce) don't count as damage.
      "-xerror",
      "-threads", "1",
      "-readrate", String(options.readRate ?? DEFAULT_READ_RATE),
      "-i", path,
      // Optional (`?`) so a file with no audio isn't reported as broken.
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-f", "null", "-",
    ],
    { ...(options.signal ? { signal: options.signal } : {}), timeoutMs: options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS },
  );
  if (result.exitCode === 0) return null;
  return (result.stderr.trim() || `ffmpeg exited with code ${result.exitCode}`).slice(0, MAX_ERROR_CHARS);
}

export interface FileHealthMonitorOptions {
  readonly repository: FileHealthRepository;
  /** True while something more important is using the CPU (a running transcode); checks wait. */
  readonly isBusy: () => boolean;
  readonly onChecked?: (path: string, error: string | null) => void;
  readonly onError?: (path: string, error: Error) => void;
  /** How long to wait when nothing is due. */
  readonly idleMs?: number;
  /** How long to wait while busy. */
  readonly busyMs?: number;
  /** Test seams. */
  readonly check?: (path: string, signal: AbortSignal) => Promise<string | null>;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly now?: () => number;
}

/**
 * Checks every media file's health in the background, one at a time and slowly, forever:
 * new and changed files first, then each file again every `FILE_HEALTH_RECHECK_DAYS`. A
 * plain loop instead of a scheduled job because one check can outlast a job's expiry. A file
 * that can't be checked (missing, or ffmpeg couldn't run) is skipped until the next restart
 * instead of being retried in a tight loop.
 */
export class FileHealthMonitor {
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private readonly skipped = new Set<string>();
  private readonly check: (path: string, signal: AbortSignal) => Promise<string | null>;
  private readonly exists: (path: string) => Promise<boolean>;
  private readonly now: () => number;

  constructor(private readonly options: FileHealthMonitorOptions) {
    this.check = options.check ?? ((path, signal) => checkFileHealth(path, { signal }));
    this.exists = options.exists ?? ((path) => access(path).then(() => true, () => false));
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Stops after killing any check in progress. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { idleMs = 10 * 60_000, busyMs = 60_000 } = this.options;
    while (!this.abort.signal.aborted) {
      const delay = this.options.isBusy() ? busyMs : await this.checkNext().then((checked) => (checked ? 0 : idleMs));
      if (delay > 0) await sleep(delay, undefined, { signal: this.abort.signal }).catch(() => undefined);
    }
  }

  /** Checks the next due file; false when there was nothing to check. */
  private async checkNext(): Promise<boolean> {
    const staleBefore = new Date(this.now() - FILE_HEALTH_RECHECK_DAYS * 24 * 60 * 60 * 1000);
    let due;
    try {
      due = await this.options.repository.listDue(this.skipped.size + 1, staleBefore);
    } catch (error) {
      this.options.onError?.("(listing due files)", error as Error);
      return false;
    }
    const file = due.find((candidate) => !this.skipped.has(candidate.id));
    if (!file) return false;

    try {
      if (!(await this.exists(file.path))) throw new Error("File not found");
      const error = await this.check(file.path, this.abort.signal);
      if (this.abort.signal.aborted) return false;
      await this.options.repository.save({ mediaFileId: file.id, checkedAt: new Date(this.now()), sizeBytes: file.sizeBytes, error });
      this.options.onChecked?.(file.path, error);
    } catch (error) {
      if (this.abort.signal.aborted) return false;
      this.skipped.add(file.id);
      this.options.onError?.(file.path, error as Error);
    }
    return true;
  }
}
