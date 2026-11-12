import { runCommand, type CommandRunner } from "./process.js";

export interface SubtitleExtractOptions {
  readonly ffmpegPath?: string;
  readonly runner?: CommandRunner;
  /** The file's text encoding when it isn't UTF-8 (a sidecar file, say): ffmpeg's `-sub_charenc`. */
  readonly inputCharset?: string;
}

/**
 * Converts one text subtitle stream to WebVTT, on the source file's timeline. Reads through
 * the whole container, so callers should cache the result. ASS styling and positioning
 * don't survive the conversion — only the text and its timing do.
 */
export async function extractWebVtt(
  path: string,
  streamIndex: number,
  options: SubtitleExtractOptions = {},
): Promise<string> {
  const runner = options.runner ?? runCommand;
  const result = await runner(options.ffmpegPath ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    ...(options.inputCharset ? ["-sub_charenc", options.inputCharset] : []),
    "-i",
    path,
    "-map",
    `0:${streamIndex}`,
    "-f",
    "webvtt",
    "pipe:1",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Subtitle extraction failed for ${path} stream ${streamIndex}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
    );
  }
  return result.stdout;
}

