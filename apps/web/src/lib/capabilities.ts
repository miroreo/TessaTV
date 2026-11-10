import type { ClientCapabilities, VideoCodecSupport } from "@tessatv/streaming";
import { getMaxBitrate } from "./preferences.js";

export type HlsEngine = "native" | "hls.js" | "none";

type ManagedMediaSourceWindow = Window & { ManagedMediaSource?: typeof MediaSource };

/**
 * Asks this browser what it can actually play, rather than guessing from the user agent.
 * Every codec is checked both as a progressive file (direct play) and through the engine
 * that will play HLS (Safari's native player, or MediaSource for hls.js), and only counts
 * if both say yes — the server uses one list for both paths.
 */
export function detectCapabilities(hasHlsJs: boolean): { capabilities: ClientCapabilities; engine: HlsEngine } {
  const video = document.createElement("video");
  const mediaSource = (window as ManagedMediaSourceWindow).ManagedMediaSource ?? window.MediaSource;
  // Apple's native HLS is the reference implementation (and the only one AirPlay and iOS
  // fullscreen work with). Chromium also claims native HLS now, but its demuxer rejects
  // fMP4 segments that hls.js plays fine, so everywhere else hls.js wins when available.
  const nativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
  const apple = /Apple/.test(navigator.vendor);
  const engine: HlsEngine =
    nativeHls && (apple || !hasHlsJs) ? "native" : hasHlsJs && mediaSource ? "hls.js" : nativeHls ? "native" : "none";

  const progressive = (mime: string) => video.canPlayType(mime) !== "";
  const viaHls = (mime: string) =>
    engine === "native" ? progressive(mime) : engine === "hls.js" ? mediaSource!.isTypeSupported(mime) : false;
  const playable = (codecs: string) => {
    const mime = `video/mp4; codecs="${codecs}"`;
    return progressive(mime) && viaHls(mime);
  };

  const videoCodecs: VideoCodecSupport[] = [];
  if (playable("avc1.640033")) videoCodecs.push({ codec: "h264", maxBitDepth: 8 });
  const hevc10 = playable("hvc1.2.4.L153.B0");
  if (hevc10 || playable("hvc1.1.6.L153.B0")) videoCodecs.push({ codec: "hevc", maxBitDepth: hevc10 ? 10 : 8 });
  const av1Ten = playable("av01.0.12M.10");
  if (av1Ten || playable("av01.0.12M.08")) videoCodecs.push({ codec: "av1", maxBitDepth: av1Ten ? 10 : 8 });
  const vp9Ten = playable("vp09.02.51.10");
  if (vp9Ten || playable("vp09.00.51.08")) videoCodecs.push({ codec: "vp9", maxBitDepth: vp9Ten ? 10 : 8 });

  const audioCodecs = (
    [
      ["aac", "mp4a.40.2"],
      ["mp3", "mp4a.69"],
      ["ac3", "ac-3"],
      ["eac3", "ec-3"],
      ["opus", "opus"],
      ["flac", "flac"],
    ] as const
  )
    .filter(([, codecs]) => {
      const mime = `audio/mp4; codecs="${codecs}"`;
      return progressive(mime) && viaHls(mime);
    })
    .map(([codec]) => ({ codec }));

  const directPlayContainers = [
    ...(progressive("video/mp4") ? ["mp4", "m4v"] : []),
    ...(progressive("video/quicktime") ? ["mov"] : []),
    ...(progressive("video/webm") ? ["webm"] : []),
    ...(progressive("video/x-matroska") || progressive("video/matroska") ? ["mkv"] : []),
  ];

  const maxBitrate = getMaxBitrate();
  return {
    engine,
    capabilities: {
      directPlayContainers,
      videoCodecs,
      audioCodecs,
      ...(maxBitrate ? { maxBitrate } : {}),
      supportsHdr: hevc10 && window.matchMedia("(dynamic-range: high)").matches,
      hls: {
        segmentContainers: ["fmp4", "mpegts"],
        videoCodecs: ["h264"],
        audioCodecs: ["aac"],
        maxAudioChannels: 2,
      },
    },
  };
}
