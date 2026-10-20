import type { TranscodeVideoCodec } from "../client-capabilities.js";
import type { VideoStreamInfo } from "../media-probe.js";

/** Add `"nvenc" | "qsv"` here as strategies are implemented — nothing else keys off this union. */
export type HardwareAccelKind = "none" | "vaapi";

export interface VideoEncodeRequest {
  readonly source: VideoStreamInfo;
  readonly codec: TranscodeVideoCodec;
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
}

/**
 * Everything accel-specific about one video transcode. Common concerns (stream mapping,
 * keyframe placement, HLS muxing) stay in `buildTranscodeArgs` so every strategy shares them.
 */
export interface VideoPipeline {
  /** Arguments placed before `-i` (device init, hwaccel decode). */
  readonly inputArgs: readonly string[];
  /** `-vf` filter chain entries, in order. */
  readonly filters: readonly string[];
  /** `-c:v <encoder>` plus rate-control arguments. */
  readonly encoderArgs: readonly string[];
  readonly decode: "hardware" | "software";
  readonly encode: "hardware" | "software";
}

/**
 * Hardware-acceleration strategy: the only thing that changes between software, VAAPI, and
 * (later) NVENC/QSV transcodes is the ffmpeg arguments this produces.
 */
export interface HardwareAccel {
  readonly kind: HardwareAccelKind;
  videoPipeline(request: VideoEncodeRequest): VideoPipeline;
}

/** Shared VBR settings: cap at the target with a 2x buffer so segment sizes stay predictable. */
export function rateControlArgs(bitrate: number): string[] {
  return ["-b:v", String(bitrate), "-maxrate", String(bitrate), "-bufsize", String(bitrate * 2)];
}
