import { access } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { FILE_HEALTH_RECHECK_DAYS, type FileHealth, type FileHealthRepository, type FileHealthSeverity } from "@tessatv/domain";
import { FfmpegProgressParser, type FfmpegProgress } from "./ffmpeg-progress.js";
import { probeMedia } from "./media-probe.js";
import { runCommand, type CommandRunner } from "./process.js";

export interface FileHealthCheckOptions {
  readonly ffmpegPath?: string;
  readonly runner?: CommandRunner;
  /** How fast ffmpeg may read the file, in multiples of realtime. Ignored at full speed. */
  readonly readRate?: number;
  /** No read-rate throttle and every CPU core, instead of one throttled thread. Still at the lowest priority. */
  readonly fullSpeed?: boolean;
  readonly signal?: AbortSignal;
  /** Called about twice a second with how far the decode has got. */
  readonly onProgress?: (progress: FfmpegProgress) => void;
  /** Gives up on a check that runs this long. */
  readonly timeoutMs?: number;
}

const DEFAULT_READ_RATE = 4;
const DEFAULT_CHECK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_ERROR_CHARS = 500;
// The null output complains about timestamps that MKVs with coarse timebases (e.g. 1/1000 s at 24-60 fps)
// legitimately repeat, once per frame. Playback is unaffected, and thousands of these lines would
// otherwise fill the stored message and hide any real decode error behind them.
const NON_MONOTONIC_DTS = /Application provided invalid, non monotonically increasing dts to muxer/;

// Messages are prefixed with the component that printed them: `[ac3 @ 0x5b...] error decoding the audio block`.
// Newer ffmpegs also print the stream's own line, `[aist#0:1/aac @ 0x5b...] [dec:aac @ 0x5b...] Error submitting packet`.
const AUDIO_CODEC = "aac\\w*|ac3|eac3|dca|dts\\w*|mp[123]\\w*|flac|opus|vorbis|truehd|mlp|alac|wma\\w*|pcm_\\w+";
const AUDIO_MESSAGE = new RegExp(`^\\[(?:aist#\\S+|dec:(?:${AUDIO_CODEC})|(?:${AUDIO_CODEC})) @`);
/** More video errors than this and a file is `major`; a handful of concealed ones is `minor`. */
export const MAJOR_VIDEO_ERROR_LIMIT = 10;

/** What a check found: the stored result minus which file it was and when. */
export type FileHealthFinding = Pick<FileHealth, "error" | "severity" | "videoErrors" | "audioErrors">;

/**
 * Grades ffmpeg's output. A non-zero exit, or more than `MAJOR_VIDEO_ERROR_LIMIT` video
 * errors, is `major`. Anything else it printed is `minor` (a few concealed video errors, or
 * trouble confined to the audio, which decoders skip over), and silence is `clean`.
 */
export function gradeFileHealth(exitCode: number, stderr: string): FileHealthFinding {
  const messages = stderr.split("\n").filter((line) => line.trim() && !NON_MONOTONIC_DTS.test(line));
  const audioErrors = messages.filter((line) => AUDIO_MESSAGE.test(line)).length;
  const videoErrors = messages.length - audioErrors;
  const severity: FileHealthSeverity =
    exitCode !== 0 || videoErrors > MAJOR_VIDEO_ERROR_LIMIT ? "major" : messages.length > 0 ? "minor" : "clean";
  if (severity === "clean") return { error: null, severity, videoErrors, audioErrors };
  const error = (messages.length > 0 ? messages.join("\n") : `ffmpeg exited with code ${exitCode}`).slice(0, MAX_ERROR_CHARS);
  return { error, severity, videoErrors, audioErrors };
}

/**
 * Decodes the first video and audio streams end to end on the CPU and grades what ffmpeg
 * complained about. Deliberately software-only: a damaged file can hang a GPU decoder, which
 * is exactly what this exists to find out safely. Runs at the lowest CPU priority, on one
 * thread, throttled to `readRate`× realtime so a check never gets in playback's way; a long
 * film takes the better part of an hour. `fullSpeed` lifts the throttle and the thread limit,
 * for catching up on a library. It reads on past a first error so the errors can be counted.
 */
export async function checkFileHealth(path: string, options: FileHealthCheckOptions = {}): Promise<FileHealthFinding> {
  const runner = options.runner ?? runCommand;
  const parser = new FfmpegProgressParser((progress) => options.onProgress?.(progress));
  const result = await runner(
    "nice",
    [
      "-n", "19",
      options.ffmpegPath ?? "ffmpeg",
      "-hide_banner", "-nostdin",
      "-v", "error", "-nostats", "-progress", "pipe:1",
      ...(options.fullSpeed ? [] : ["-threads", "1", "-readrate", String(options.readRate ?? DEFAULT_READ_RATE)]),
      "-i", path,
      // Optional (`?`) so a file with no audio isn't reported as broken.
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-f", "null", "-",
    ],
    {
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      ...(options.onProgress ? { onStdout: (chunk: string) => parser.push(chunk) } : {}),
    },
  );
  // At `-v error` ffmpeg prints only real errors (warnings, like odd timestamps, are hidden),
  // and exits 0 on plenty of them: a HEVC stream with broken references or a Matroska element
  // overrunning its parent decodes "successfully" with errors logged. So the output is graded, not just the exit code.
  return gradeFileHealth(result.exitCode, result.stderr);
}

export type FileHealthMonitorState = "disabled" | "waiting" | "checking" | "idle";

/** The file being decoded right now, and how far along it is. */
export interface FileHealthProgress {
  readonly path: string;
  readonly startedAt: Date;
  /** Null when the file's length couldn't be read, so there's no percentage to show. */
  readonly durationSeconds: number | null;
  /** How far into the file the decode has got. */
  readonly positionSeconds: number;
  readonly fps: number | null;
  /** Relative to realtime; throttled to a few times realtime unless running at full speed. */
  readonly speed: number | null;
}

export interface FileHealthMonitorStatus {
  readonly state: FileHealthMonitorState;
  /** Whether checks are running unthrottled right now. */
  readonly fullSpeed: boolean;
  readonly current: FileHealthProgress | null;
}

export interface FileHealthMonitorOptions {
  readonly repository: FileHealthRepository;
  /** Read before every file and while one is being checked: turning it off stops the check in progress. */
  readonly isEnabled: () => Promise<boolean>;
  /**
   * Read like `isEnabled`: at full speed checks are unthrottled and don't wait for transcodes,
   * and a change restarts the check in progress so it takes effect now.
   */
  readonly isFullSpeed?: () => Promise<boolean>;
  /** True while something more important is using the CPU (a running transcode); checks wait, except at full speed. */
  readonly isBusy: () => boolean;
  readonly onChecked?: (path: string, finding: FileHealthFinding) => void;
  readonly onError?: (path: string, error: Error) => void;
  /** How long to wait when nothing is due. */
  readonly idleMs?: number;
  /** How long to wait while busy. */
  readonly busyMs?: number;
  /** How long to wait while disabled before looking at the setting again. */
  readonly disabledMs?: number;
  /** How often a running check looks at whether it's still enabled. */
  readonly enabledPollMs?: number;
  /** Test seams. */
  readonly check?: (path: string, signal: AbortSignal, onProgress: (progress: FfmpegProgress) => void, fullSpeed: boolean) => Promise<FileHealthFinding>;
  readonly duration?: (path: string) => Promise<number | null>;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly now?: () => number;
}

/**
 * Checks every media file's health in the background, one at a time and slowly, while
 * enabled: new and changed files first, then each file again every `FILE_HEALTH_RECHECK_DAYS`.
 * A plain loop instead of a scheduled job because one check can outlast a job's expiry. A
 * file that can't be checked (missing, or ffmpeg couldn't run) is skipped until the next
 * restart instead of being retried in a tight loop.
 */
export class FileHealthMonitor {
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private readonly skipped = new Set<string>();
  private currentState: FileHealthMonitorState = "idle";
  private fullSpeed = false;
  private current: FileHealthProgress | null = null;
  private readonly check: NonNullable<FileHealthMonitorOptions["check"]>;
  private readonly duration: (path: string) => Promise<number | null>;
  private readonly exists: (path: string) => Promise<boolean>;
  private readonly now: () => number;

  constructor(private readonly options: FileHealthMonitorOptions) {
    this.check = options.check ?? ((path, signal, onProgress, fullSpeed) => checkFileHealth(path, { signal, onProgress, fullSpeed }));
    this.duration = options.duration ?? ((path) => probeMedia(path).then((media) => media.durationSeconds, () => null));
    this.exists = options.exists ?? ((path) => access(path).then(() => true, () => false));
    this.now = options.now ?? Date.now;
  }

  status(): FileHealthMonitorStatus {
    return { state: this.currentState, fullSpeed: this.fullSpeed, current: this.current };
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Stops after killing any check in progress. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /** Reading the setting failing (e.g. the database is down) counts as off: better idle than guessing. */
  private async enabled(): Promise<boolean> {
    return this.options.isEnabled().catch(() => false);
  }

  private async readFullSpeed(): Promise<boolean> {
    return this.options.isFullSpeed ? this.options.isFullSpeed().catch(() => false) : false;
  }

  private async run(): Promise<void> {
    const { idleMs = 10 * 60_000, busyMs = 60_000, disabledMs = 30_000 } = this.options;
    while (!this.abort.signal.aborted) {
      let delay: number;
      if (!(await this.enabled())) {
        this.currentState = "disabled";
        delay = disabledMs;
      } else if (!(this.fullSpeed = await this.readFullSpeed()) && this.options.isBusy()) {
        this.currentState = "waiting";
        delay = busyMs;
      } else if (await this.checkNext()) {
        delay = 0;
      } else {
        this.currentState = "idle";
        delay = idleMs;
      }
      if (delay > 0) await sleep(delay, undefined, { signal: this.abort.signal }).catch(() => undefined);
    }
  }

  /** Checks the next due file; false when there was nothing to check (or the monitor is stopping). */
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

    // Aborted by `stop()`, or by this check's own watcher when the setting is turned off or
    // full speed is switched, so a change takes effect on the file in progress, not the next one.
    const fullSpeed = this.fullSpeed;
    // Linked by hand rather than `AbortSignal.any`, which can keep every per-file signal alive
    // as long as `this.abort.signal` is.
    const checkAbort = new AbortController();
    const signal = checkAbort.signal;
    let settingChanged = false;
    const onStop = () => checkAbort.abort();
    if (this.abort.signal.aborted) onStop();
    else this.abort.signal.addEventListener("abort", onStop, { once: true });
    const watcher = setInterval(() => {
      void Promise.all([this.enabled(), this.readFullSpeed()]).then(([on, speed]) => {
        if (!on || speed !== fullSpeed) {
          settingChanged = true;
          checkAbort.abort();
        }
      });
    }, this.options.enabledPollMs ?? 15_000);
    this.currentState = "checking";
    const current: FileHealthProgress = { path: file.path, startedAt: new Date(this.now()), durationSeconds: null, positionSeconds: 0, fps: null, speed: null };
    this.current = current;
    try {
      if (!(await this.exists(file.path))) throw new Error("File not found");
      this.current = { ...current, durationSeconds: await this.duration(file.path) };
      const finding = await this.check(
        file.path,
        signal,
        ({ outTimeSeconds, fps, speed }) => {
          if (this.current) this.current = { ...this.current, positionSeconds: outTimeSeconds, fps, speed };
        },
        fullSpeed,
      );
      if (signal.aborted) return settingChanged;
      await this.options.repository.save({ mediaFileId: file.id, checkedAt: new Date(this.now()), sizeBytes: file.sizeBytes, ...finding });
      this.options.onChecked?.(file.path, finding);
    } catch (error) {
      // Stopped for good: no. A setting changed mid-check: yes, so the loop sees it at once.
      if (signal.aborted) return settingChanged;
      this.skipped.add(file.id);
      this.options.onError?.(file.path, error as Error);
    } finally {
      clearInterval(watcher);
      this.abort.signal.removeEventListener("abort", onStop);
      this.current = null;
    }
    return true;
  }
}
