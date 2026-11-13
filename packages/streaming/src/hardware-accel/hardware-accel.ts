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
  /** Subtitles will be drawn on, so frames must be in system memory after `filters`. */
  readonly burnIn?: boolean;
}

/**
 * Everything accel-specific about one video transcode. Common concerns (stream mapping,
 * keyframe placement, HLS muxing) stay in `buildTranscodeArgs` so every strategy shares them.
 */
export interface VideoPipeline {
  /** Arguments placed before `-i` (device init, hwaccel decode). */
  readonly inputArgs: readonly string[];
  /** Filter chain entries, in order. Leaves frames at the target size. */
  readonly filters: readonly string[];
  /** Applied after `filters` and any subtitle overlay (e.g. moving frames onto the GPU). */
  readonly postOverlayFilters: readonly string[];
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
  /** The device node it runs on (e.g. `/dev/dri/renderD128`); absent for software. */
  readonly device?: string | null;
  /** The GPU (or, for software, CPU) doing the work, for display. */
  readonly deviceName: string | null;
  videoPipeline(request: VideoEncodeRequest): VideoPipeline;
}

/** Shared VBR settings: cap at the target with a 2x buffer so segment sizes stay predictable. */
export function rateControlArgs(bitrate: number): string[] {
  return ["-b:v", String(bitrate), "-maxrate", String(bitrate), "-bufsize", String(bitrate * 2)];
}

/**
 * PQ/HLG to 8-bit SDR, in software: VAAPI's `tonemap_vaapi` needs driver HDR support that
 * AMD's Mesa driver doesn't have. Scaling first keeps 4K sources affordable, since
 * everything after the first `zscale` runs per pixel on 32-bit float frames.
 */
export function toneMapFilters(width: number, height: number, outputFormat: string): string[] {
  return [
    `zscale=w=${width}:h=${height}:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
    `format=${outputFormat}`,
  ];
}

/** Tags tone-mapped output so players don't guess at its colorspace. */
export const SDR_COLOR_ARGS: readonly string[] = [
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
];
