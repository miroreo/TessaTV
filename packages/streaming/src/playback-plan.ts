import type {
  AudioCodecSupport,
  ClientCapabilities,
  HlsSegmentContainer,
  TranscodeAudioCodec,
  TranscodeVideoCodec,
  VideoCodecSupport,
} from "./client-capabilities.js";
import type { AudioStreamInfo, MediaProbe, VideoStreamInfo } from "./media-probe.js";

/** Why a file can't be played as-is. Kept generic; `jellyfin-compat` maps these to `TranscodeReasons`. */
export type TranscodeReason =
  | "ContainerNotSupported"
  | "VideoCodecNotSupported"
  | "VideoProfileNotSupported"
  | "VideoResolutionNotSupported"
  | "VideoBitDepthNotSupported"
  | "AudioCodecNotSupported"
  | "AudioChannelsNotSupported"
  | "ContainerBitrateExceedsLimit"
  | "VideoCodecNotSupportedInSegmentContainer"
  | "AudioCodecNotSupportedInSegmentContainer";

export type VideoAction =
  | { readonly kind: "copy"; readonly streamIndex: number; readonly codec: string }
  | {
      readonly kind: "transcode";
      readonly streamIndex: number;
      readonly source: VideoStreamInfo;
      readonly codec: TranscodeVideoCodec;
      readonly width: number;
      readonly height: number;
      readonly bitrate: number;
    };

export type AudioAction =
  | { readonly kind: "copy"; readonly streamIndex: number; readonly codec: string }
  | {
      readonly kind: "transcode";
      readonly streamIndex: number;
      readonly codec: TranscodeAudioCodec;
      readonly channels: number;
      readonly bitrate: number;
    };

export type PlaybackPlan =
  | {
      /** Serve the file untouched; no ffmpeg involved. */
      readonly mode: "direct-play";
      readonly path: string;
      readonly reasons: readonly TranscodeReason[];
    }
  | {
      /** `remux` copies the video stream into HLS; `transcode` re-encodes it. */
      readonly mode: "remux" | "transcode";
      readonly path: string;
      readonly segmentContainer: HlsSegmentContainer;
      readonly video: VideoAction | null;
      readonly audio: AudioAction | null;
      /** Why direct play wasn't possible. */
      readonly reasons: readonly TranscodeReason[];
    };

export type HlsPlaybackPlan = Extract<PlaybackPlan, { mode: "remux" | "transcode" }>;

export interface PlaybackOptions {
  /** Absolute ffprobe stream index; defaults to the default (else first) audio stream. */
  readonly audioStreamIndex?: number;
  /** Forces an HLS transcode even when direct play would work (e.g. client-requested). */
  readonly forceTranscode?: boolean;
  readonly maxHeight?: number;
}

const SEGMENT_VIDEO_CODECS: Record<HlsSegmentContainer, ReadonlySet<string>> = {
  mpegts: new Set(["h264"]),
  fmp4: new Set(["h264", "hevc", "av1"]),
};

const SEGMENT_AUDIO_CODECS: Record<HlsSegmentContainer, ReadonlySet<string>> = {
  mpegts: new Set(["aac", "mp3", "ac3", "eac3"]),
  fmp4: new Set(["aac", "mp3", "ac3", "eac3", "opus", "flac", "alac"]),
};

function pickPreferred<T extends { readonly index: number; readonly isDefault: boolean }>(
  streams: readonly T[],
  requestedIndex?: number,
): T | null {
  if (requestedIndex !== undefined) {
    const requested = streams.find((stream) => stream.index === requestedIndex);
    if (!requested) throw new Error(`No stream with index ${requestedIndex}`);
    return requested;
  }
  return streams.find((stream) => stream.isDefault) ?? streams[0] ?? null;
}

function videoIssues(
  stream: VideoStreamInfo,
  support: readonly VideoCodecSupport[],
  maxHeight: number | undefined,
): TranscodeReason[] {
  const codecSupport = support.find((entry) => entry.codec === stream.codec);
  if (!codecSupport) return ["VideoCodecNotSupported"];
  const issues: TranscodeReason[] = [];
  if (codecSupport.profiles && (!stream.profile || !codecSupport.profiles.includes(stream.profile))) {
    issues.push("VideoProfileNotSupported");
  }
  const heightLimit = Math.min(codecSupport.maxHeight ?? Infinity, maxHeight ?? Infinity);
  if (stream.height > heightLimit || stream.width > (codecSupport.maxWidth ?? Infinity)) {
    issues.push("VideoResolutionNotSupported");
  }
  if (stream.bitDepth > (codecSupport.maxBitDepth ?? Infinity)) issues.push("VideoBitDepthNotSupported");
  return issues;
}

function audioIssues(stream: AudioStreamInfo, support: readonly AudioCodecSupport[]): TranscodeReason[] {
  const codecSupport = support.find((entry) => entry.codec === stream.codec);
  if (!codecSupport) return ["AudioCodecNotSupported"];
  return stream.channels > (codecSupport.maxChannels ?? Infinity) ? ["AudioChannelsNotSupported"] : [];
}

/** Fits the source inside the client's limits, preserving aspect ratio, with even dimensions. */
function targetDimensions(source: VideoStreamInfo, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(source.width), height: even(source.height) };
}

/** Rough per-resolution ceilings; a source already under its ceiling isn't inflated. */
function defaultVideoBitrate(height: number): number {
  if (height <= 480) return 1_500_000;
  if (height <= 720) return 4_000_000;
  if (height <= 1080) return 8_000_000;
  return 20_000_000;
}

function audioBitrateFor(channels: number): number {
  return channels > 2 ? 384_000 : 192_000;
}

/**
 * Decides how a file gets to a client: untouched, video copied into HLS, or re-encoded.
 * Pure and hardware-agnostic — which encoder actually runs is the `HardwareAccel`
 * strategy's job, applied later when building ffmpeg arguments.
 */
export function resolvePlaybackPlan(
  probe: MediaProbe,
  capabilities: ClientCapabilities,
  options: PlaybackOptions = {},
): PlaybackPlan {
  const video = pickPreferred(probe.videoStreams);
  const audio = pickPreferred(probe.audioStreams, options.audioStreamIndex);
  if (!video && !audio) throw new Error(`${probe.path} has no playable audio or video streams`);

  const videoReasons = video ? videoIssues(video, capabilities.videoCodecs, options.maxHeight) : [];
  const audioReasons = audio ? audioIssues(audio, capabilities.audioCodecs) : [];
  const overBitrate =
    capabilities.maxBitrate !== undefined && probe.bitRate !== null && probe.bitRate > capabilities.maxBitrate;
  const containerOk = capabilities.directPlayContainers.includes(probe.container);

  const reasons: TranscodeReason[] = [
    ...(containerOk ? [] : (["ContainerNotSupported"] as const)),
    ...videoReasons,
    ...audioReasons,
    ...(overBitrate ? (["ContainerBitrateExceedsLimit"] as const) : []),
  ];

  if (reasons.length === 0 && !options.forceTranscode) {
    return { mode: "direct-play", path: probe.path, reasons };
  }

  const canCopyVideo = video !== null && videoReasons.length === 0 && !overBitrate && !options.forceTranscode;
  const segmentContainer = chooseSegmentContainer(capabilities, canCopyVideo ? video : null);
  const copyVideo = canCopyVideo && segmentContainer.videoCopyOk;
  if (canCopyVideo && !copyVideo) reasons.push("VideoCodecNotSupportedInSegmentContainer");

  const copyAudio =
    audio !== null && audioReasons.length === 0 && SEGMENT_AUDIO_CODECS[segmentContainer.container].has(audio.codec);
  if (audio && audioReasons.length === 0 && !copyAudio) reasons.push("AudioCodecNotSupportedInSegmentContainer");

  const audioAction: AudioAction | null = !audio
    ? null
    : copyAudio
      ? { kind: "copy", streamIndex: audio.index, codec: audio.codec }
      : transcodeAudio(audio, capabilities, segmentContainer.container);

  let videoAction: VideoAction | null = null;
  if (video && copyVideo) {
    videoAction = { kind: "copy", streamIndex: video.index, codec: video.codec };
  } else if (video) {
    const codec = capabilities.hls.videoCodecs.find((candidate) =>
      SEGMENT_VIDEO_CODECS[segmentContainer.container].has(candidate),
    );
    if (!codec) {
      throw new Error(`Client accepts no transcode video codec usable in ${segmentContainer.container} segments`);
    }
    const codecSupport = capabilities.videoCodecs.find((entry) => entry.codec === codec);
    const { width, height } = targetDimensions(
      video,
      codecSupport?.maxWidth ?? Infinity,
      Math.min(codecSupport?.maxHeight ?? Infinity, options.maxHeight ?? Infinity),
    );
    const bitrateBudget =
      capabilities.maxBitrate !== undefined
        ? capabilities.maxBitrate - (audioAction?.kind === "transcode" ? audioAction.bitrate : (audio?.bitRate ?? 0))
        : Infinity;
    const sourceBitrate = video.bitRate ?? probe.bitRate ?? Infinity;
    const bitrate = Math.max(
      500_000,
      Math.round(Math.min(defaultVideoBitrate(height), sourceBitrate, bitrateBudget)),
    );
    videoAction = { kind: "transcode", streamIndex: video.index, source: video, codec, width, height, bitrate };
  }

  return {
    mode: videoAction?.kind === "transcode" ? "transcode" : "remux",
    path: probe.path,
    segmentContainer: segmentContainer.container,
    video: videoAction,
    audio: audioAction,
    reasons,
  };
}

/**
 * Prefers a segment container that can carry the source video as-is (avoiding a
 * transcode), falling back to the client's first preference.
 */
function chooseSegmentContainer(capabilities: ClientCapabilities, copyableVideo: VideoStreamInfo | null) {
  const preferences = capabilities.hls.segmentContainers;
  if (preferences.length === 0) throw new Error("Client supports no HLS segment containers");
  if (copyableVideo) {
    const fitting = preferences.find((container) => SEGMENT_VIDEO_CODECS[container].has(copyableVideo.codec));
    if (fitting) return { container: fitting, videoCopyOk: true };
  }
  return { container: preferences[0]!, videoCopyOk: false };
}

function transcodeAudio(
  source: AudioStreamInfo,
  capabilities: ClientCapabilities,
  container: HlsSegmentContainer,
): AudioAction {
  const codec = capabilities.hls.audioCodecs.find((candidate) => SEGMENT_AUDIO_CODECS[container].has(candidate));
  if (!codec) throw new Error(`Client accepts no transcode audio codec usable in ${container} segments`);
  const codecLimit = capabilities.audioCodecs.find((entry) => entry.codec === codec)?.maxChannels;
  const channels = Math.min(source.channels, capabilities.hls.maxAudioChannels ?? 2, codecLimit ?? Infinity);
  return { kind: "transcode", streamIndex: source.index, codec, channels, bitrate: audioBitrateFor(channels) };
}
