import { extname } from "node:path";
import { runCommand, type CommandRunner } from "./process.js";

interface StreamInfoBase {
  /** ffmpeg's absolute stream index within the file (what `-map 0:<index>` takes). */
  readonly index: number;
  readonly codec: string;
  readonly language: string | null;
  readonly title: string | null;
  readonly isDefault: boolean;
}

export interface VideoStreamInfo extends StreamInfoBase {
  readonly profile: string | null;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string | null;
  readonly bitDepth: number;
  readonly frameRate: number | null;
  readonly bitRate: number | null;
  /** PQ or HLG transfer. Transcoding these without tone-mapping produces washed-out output. */
  readonly isHdr: boolean;
}

export interface AudioStreamInfo extends StreamInfoBase {
  readonly profile: string | null;
  readonly channels: number;
  readonly channelLayout: string | null;
  readonly sampleRate: number | null;
  readonly bitRate: number | null;
}

export interface SubtitleStreamInfo extends StreamInfoBase {
  readonly isForced: boolean;
  /** Text subtitles (SRT/ASS/...) can be converted; image subtitles (PGS/VobSub) can only be burned in. */
  readonly isTextBased: boolean;
}

/** Container-agnostic description of a media file, derived from ffprobe. */
export interface MediaProbe {
  readonly path: string;
  /** Normalized container name (`mkv`, `mp4`, `avi`, ...) — see `normalizeContainer`. */
  readonly container: string;
  readonly durationSeconds: number | null;
  /** Overall bitrate in bits/second. */
  readonly bitRate: number | null;
  readonly sizeBytes: number | null;
  readonly videoStreams: readonly VideoStreamInfo[];
  readonly audioStreams: readonly AudioStreamInfo[];
  readonly subtitleStreams: readonly SubtitleStreamInfo[];
}

const TEXT_SUBTITLE_CODECS = new Set(["subrip", "ass", "ssa", "webvtt", "mov_text", "text"]);
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

/**
 * ffprobe reports format families (`matroska,webm`, `mov,mp4,m4a,...`) rather than the
 * specific container, so the file extension disambiguates within a family.
 */
export function normalizeContainer(formatName: string, path: string): string {
  const families = formatName.split(",");
  const extension = extname(path).slice(1).toLowerCase();
  if (families.includes("matroska")) return extension === "webm" ? "webm" : "mkv";
  if (families.includes("mov")) return ["mov", "m4v"].includes(extension) ? extension : "mp4";
  if (families.includes("mpegts")) return "ts";
  return families[0] ?? formatName;
}

function bitDepthFromPixelFormat(pixelFormat: string | null): number {
  if (!pixelFormat) return 8;
  if (/p010|10(le|be)$/.test(pixelFormat)) return 10;
  if (/p012|12(le|be)$/.test(pixelFormat)) return 12;
  return 8;
}

function parseRational(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!numerator || !denominator) return null;
  return numerator / denominator;
}

function parseNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value !== "unknown" ? value : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ffprobe's JSON is untyped wire data. */
function baseInfo(stream: any): StreamInfoBase {
  return {
    index: stream.index,
    codec: stream.codec_name ?? "unknown",
    language: stringOrNull(stream.tags?.language),
    title: stringOrNull(stream.tags?.title),
    isDefault: stream.disposition?.default === 1,
  };
}

/** Pure mapping from `ffprobe -print_format json -show_format -show_streams` output. */
export function parseFfprobeOutput(path: string, output: any): MediaProbe {
  const streams: any[] = output.streams ?? [];
  const format = output.format ?? {};

  const videoStreams: VideoStreamInfo[] = streams
    // Embedded cover art (mjpeg/png "video" streams) isn't playable video.
    .filter((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1)
    .map((stream) => {
      const pixelFormat = stringOrNull(stream.pix_fmt);
      return {
        ...baseInfo(stream),
        profile: stringOrNull(stream.profile),
        width: stream.width ?? 0,
        height: stream.height ?? 0,
        pixelFormat,
        bitDepth: parseNumber(stream.bits_per_raw_sample) ?? bitDepthFromPixelFormat(pixelFormat),
        frameRate: parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate),
        bitRate: parseNumber(stream.bit_rate),
        isHdr: HDR_TRANSFERS.has(stream.color_transfer),
      };
    });

  const audioStreams: AudioStreamInfo[] = streams
    .filter((stream) => stream.codec_type === "audio")
    .map((stream) => ({
      ...baseInfo(stream),
      profile: stringOrNull(stream.profile),
      channels: stream.channels ?? 2,
      channelLayout: stringOrNull(stream.channel_layout),
      sampleRate: parseNumber(stream.sample_rate),
      bitRate: parseNumber(stream.bit_rate),
    }));

  const subtitleStreams: SubtitleStreamInfo[] = streams
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream) => ({
      ...baseInfo(stream),
      isForced: stream.disposition?.forced === 1,
      isTextBased: TEXT_SUBTITLE_CODECS.has(stream.codec_name),
    }));

  return {
    path,
    container: normalizeContainer(format.format_name ?? "", path),
    durationSeconds: parseNumber(format.duration),
    bitRate: parseNumber(format.bit_rate),
    sizeBytes: parseNumber(format.size),
    videoStreams,
    audioStreams,
    subtitleStreams,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ProbeOptions {
  readonly ffprobePath?: string;
  readonly runner?: CommandRunner;
}

export async function probeMedia(path: string, options: ProbeOptions = {}): Promise<MediaProbe> {
  const runner = options.runner ?? runCommand;
  const result = await runner(options.ffprobePath ?? "ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`ffprobe failed for ${path}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
  return parseFfprobeOutput(path, JSON.parse(result.stdout));
}
