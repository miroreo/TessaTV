import { join } from "node:path";
import type { HardwareAccel, VideoPipeline } from "./hardware-accel/hardware-accel.js";
import type { HlsPlaybackPlan } from "./playback-plan.js";

export const PLAYLIST_FILENAME = "index.m3u8";

export interface HlsOutputOptions {
  readonly directory: string;
  /** Target segment length; keyframes are forced on this boundary when transcoding. */
  readonly segmentSeconds?: number;
  /** Seek offset into the source, for resuming or seeking past what's been transcoded. */
  readonly startTimeSeconds?: number;
}

export const DEFAULT_SEGMENT_SECONDS = 6;

/**
 * Turns a plan + strategy into one ffmpeg invocation writing an HLS playlist into
 * `output.directory`. Pure — the strategy contributes only its `VideoPipeline`.
 */
export function buildTranscodeArgs(plan: HlsPlaybackPlan, accel: HardwareAccel, output: HlsOutputOptions): string[] {
  const segmentSeconds = output.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
  const video = plan.video;
  const pipeline: VideoPipeline | null =
    video?.kind === "transcode"
      ? accel.videoPipeline({
          source: video.source,
          codec: video.codec,
          width: video.width,
          height: video.height,
          bitrate: video.bitrate,
        })
      : null;

  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
  if (pipeline) args.push(...pipeline.inputArgs);
  if (output.startTimeSeconds) args.push("-ss", String(output.startTimeSeconds));
  args.push("-i", plan.path);

  if (video) args.push("-map", `0:${video.streamIndex}`);
  if (plan.audio) args.push("-map", `0:${plan.audio.streamIndex}`);

  if (video?.kind === "copy") {
    args.push("-c:v", "copy");
  } else if (video && pipeline) {
    if (pipeline.filters.length > 0) args.push("-vf", pipeline.filters.join(","));
    args.push(...pipeline.encoderArgs);
    // Aligns keyframes with segment boundaries so every segment starts independently decodable.
    args.push("-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`);
  }
  const outputVideoCodec = video?.codec;
  // Apple players reject HEVC tagged hev1 (ffmpeg's default) inside fMP4.
  if (outputVideoCodec === "hevc" && plan.segmentContainer === "fmp4") args.push("-tag:v", "hvc1");

  if (plan.audio?.kind === "copy") {
    args.push("-c:a", "copy");
  } else if (plan.audio) {
    args.push(
      "-c:a",
      plan.audio.codec,
      "-ac",
      String(plan.audio.channels),
      "-b:a",
      String(plan.audio.bitrate),
    );
  }

  const segmentExtension = plan.segmentContainer === "fmp4" ? "m4s" : "ts";
  args.push(
    "-sn",
    "-dn",
    "-max_muxing_queue_size",
    "2048",
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    plan.segmentContainer,
    ...(plan.segmentContainer === "fmp4" ? ["-hls_fmp4_init_filename", "init.mp4"] : []),
    "-hls_segment_filename",
    join(output.directory, `segment%05d.${segmentExtension}`),
    join(output.directory, PLAYLIST_FILENAME),
  );
  return args;
}
