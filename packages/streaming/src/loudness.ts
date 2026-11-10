import type { LoudnessRepository } from "@tessatv/domain";
import { probeMedia, type MediaProbe } from "./media-probe.js";
import { runCommand, type CommandRunner } from "./process.js";

export interface LoudnessResult {
  readonly integratedLufs: number | null;
  readonly truePeakDbtp: number | null;
}

export interface LoudnessOptions {
  readonly ffmpegPath?: string;
  readonly runner?: CommandRunner;
}

/** Reads the totals from ffmpeg's `ebur128` filter summary (printed to stderr at the end). */
export function parseEbur128Summary(stderr: string): LoudnessResult {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integrated = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1];
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1];
  const number = (value: string | undefined) => (value === undefined || value === "-inf" ? null : Number(value));
  return { integratedLufs: number(integrated), truePeakDbtp: number(peak) };
}

/**
 * Measures one audio stream's integrated loudness (EBU R128 / ITU-R BS.1770) with ffmpeg's
 * own `ebur128` filter. Decodes the whole stream — a few seconds for a TV episode, minutes
 * for a lossless film track — so it runs at the lowest CPU priority, out of playback's way.
 */
export async function measureLoudness(
  path: string,
  streamIndex: number,
  options: LoudnessOptions = {},
): Promise<LoudnessResult> {
  const runner = options.runner ?? runCommand;
  const result = await runner("nice", [
    "-n", "19",
    options.ffmpegPath ?? "ffmpeg",
    "-hide_banner", "-nostdin",
    "-i", path,
    "-map", `0:${streamIndex}`,
    "-vn", "-sn", "-dn",
    "-af", "ebur128=peak=true:framelog=quiet",
    "-f", "null", "-",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Loudness measurement failed for ${path}: ${result.stderr.trim().split("\n").at(-1) ?? `exit ${result.exitCode}`}`);
  }
  return parseEbur128Summary(result.stderr);
}

export interface LoudnessScanOptions {
  readonly repository: LoudnessRepository;
  /** Stops starting new files after this long, so a scheduled run stays inside its window. */
  readonly budgetMs: number;
  readonly batchSize?: number;
  /** Test seams. */
  readonly probe?: (path: string) => Promise<MediaProbe>;
  readonly measure?: (path: string, streamIndex: number) => Promise<LoudnessResult>;
  readonly now?: () => number;
}

export interface LoudnessScanSummary {
  readonly measured: number;
  readonly failed: number;
}

/**
 * Measures files that haven't been yet, newest imports first, one at a time. The stream
 * measured is the one playback picks by default (the default-flagged audio track). A file
 * that fails is recorded with its error rather than retried on every run.
 */
export async function measureMissingLoudness(options: LoudnessScanOptions): Promise<LoudnessScanSummary> {
  const now = options.now ?? Date.now;
  const probe = options.probe ?? probeMedia;
  const measure = options.measure ?? ((path: string, index: number) => measureLoudness(path, index));
  const deadline = now() + options.budgetMs;
  let measured = 0;
  let failed = 0;

  while (now() < deadline) {
    const files = await options.repository.listUnmeasured(options.batchSize ?? 20);
    if (files.length === 0) break;
    for (const file of files) {
      if (now() >= deadline) break;
      let streamIndex = -1;
      try {
        const media = await probe(file.path);
        const audio = media.audioStreams.find((stream) => stream.isDefault) ?? media.audioStreams[0];
        if (!audio) throw new Error("No audio stream");
        streamIndex = audio.index;
        const result = await measure(file.path, streamIndex);
        await options.repository.save({ mediaFileId: file.id, streamIndex, ...result, measuredAt: new Date(now()), error: null });
        measured += 1;
      } catch (error) {
        await options.repository.save({
          mediaFileId: file.id,
          streamIndex,
          integratedLufs: null,
          truePeakDbtp: null,
          measuredAt: new Date(now()),
          error: (error as Error).message.slice(0, 500),
        });
        failed += 1;
      }
    }
  }
  return { measured, failed };
}
