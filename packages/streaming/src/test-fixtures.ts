// Shared builders for tests. Not exported from the package barrel.
import type { ClientCapabilities } from "./client-capabilities.js";
import type { AudioStreamInfo, MediaProbe, VideoStreamInfo } from "./media-probe.js";

export function videoStream(overrides: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return {
    index: 0,
    codec: "h264",
    language: null,
    title: null,
    isDefault: true,
    profile: "High",
    width: 1920,
    height: 1080,
    pixelFormat: "yuv420p",
    bitDepth: 8,
    frameRate: 23.976,
    bitRate: null,
    isHdr: false,
    ...overrides,
  };
}

export function audioStream(overrides: Partial<AudioStreamInfo> = {}): AudioStreamInfo {
  return {
    index: 1,
    codec: "aac",
    language: null,
    title: null,
    isDefault: true,
    profile: "LC",
    channels: 2,
    channelLayout: "stereo",
    sampleRate: 48000,
    bitRate: 192_000,
    ...overrides,
  };
}

export function mediaProbe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    path: "/media/file.mp4",
    container: "mp4",
    durationSeconds: 1200,
    bitRate: 5_000_000,
    sizeBytes: 750_000_000,
    videoStreams: [videoStream()],
    audioStreams: [audioStream()],
    subtitleStreams: [],
    ...overrides,
  };
}

/** Roughly what an iPhone can play: progressive MP4, H.264/HEVC, HLS in fMP4 or TS. */
export function iosLikeCapabilities(overrides: Partial<ClientCapabilities> = {}): ClientCapabilities {
  return {
    directPlayContainers: ["mp4", "mov", "m4v"],
    videoCodecs: [
      { codec: "h264", maxBitDepth: 8 },
      { codec: "hevc", maxBitDepth: 10 },
    ],
    audioCodecs: [
      { codec: "aac", maxChannels: 6 },
      { codec: "ac3", maxChannels: 6 },
      { codec: "eac3", maxChannels: 6 },
    ],
    hls: {
      segmentContainers: ["fmp4", "mpegts"],
      videoCodecs: ["h264"],
      audioCodecs: ["aac"],
      maxAudioChannels: 2,
    },
    ...overrides,
  };
}
