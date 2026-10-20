import { describe, expect, it } from "vitest";
import { resolvePlaybackPlan, type HlsPlaybackPlan } from "./playback-plan.js";
import { audioStream, iosLikeCapabilities, mediaProbe, videoStream } from "./test-fixtures.js";

function hlsPlan(plan: ReturnType<typeof resolvePlaybackPlan>): HlsPlaybackPlan {
  if (plan.mode === "direct-play") throw new Error("expected an HLS plan");
  return plan;
}

describe("resolvePlaybackPlan", () => {
  it("direct-plays a file the client supports as-is", () => {
    expect(resolvePlaybackPlan(mediaProbe(), iosLikeCapabilities())).toEqual({
      mode: "direct-play",
      path: "/media/file.mp4",
      reasons: [],
    });
  });

  it("remuxes into HLS when only the container is unsupported", () => {
    const plan = hlsPlan(resolvePlaybackPlan(mediaProbe({ container: "mkv" }), iosLikeCapabilities()));
    expect(plan).toMatchObject({
      mode: "remux",
      segmentContainer: "fmp4",
      video: { kind: "copy", streamIndex: 0, codec: "h264" },
      audio: { kind: "copy", streamIndex: 1, codec: "aac" },
      reasons: ["ContainerNotSupported"],
    });
  });

  it("picks a segment container that can carry copied HEVC rather than transcoding it", () => {
    const capabilities = iosLikeCapabilities({ hls: { ...iosLikeCapabilities().hls, segmentContainers: ["mpegts", "fmp4"] } });
    const probe = mediaProbe({ container: "mkv", videoStreams: [videoStream({ codec: "hevc", profile: "Main 10", bitDepth: 10 })] });
    const plan = hlsPlan(resolvePlaybackPlan(probe, capabilities));
    expect(plan.mode).toBe("remux");
    expect(plan.segmentContainer).toBe("fmp4");
    expect(plan.video).toMatchObject({ kind: "copy", codec: "hevc" });
  });

  it("transcodes video the client can't decode, and audio it can't either", () => {
    const probe = mediaProbe({
      container: "mkv",
      videoStreams: [videoStream({ codec: "av1", profile: "Main", bitDepth: 10, pixelFormat: "yuv420p10le" })],
      audioStreams: [audioStream({ codec: "opus", channels: 2 })],
    });
    const plan = hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities()));
    expect(plan.mode).toBe("transcode");
    expect(plan.reasons).toEqual(["ContainerNotSupported", "VideoCodecNotSupported", "AudioCodecNotSupported"]);
    expect(plan.video).toMatchObject({ kind: "transcode", codec: "h264", width: 1920, height: 1080 });
    expect(plan.audio).toEqual({ kind: "transcode", streamIndex: 1, codec: "aac", channels: 2, bitrate: 192_000 });
  });

  it("transcodes 10-bit H.264 for a client limited to 8-bit", () => {
    const probe = mediaProbe({ videoStreams: [videoStream({ profile: "High 10", bitDepth: 10 })] });
    const plan = hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities()));
    expect(plan.reasons).toEqual(["VideoBitDepthNotSupported"]);
    expect(plan.video?.kind).toBe("transcode");
  });

  it("rejects profiles outside the client's allow-list", () => {
    const capabilities = iosLikeCapabilities({ videoCodecs: [{ codec: "h264", profiles: ["Main", "High"] }] });
    const probe = mediaProbe({ videoStreams: [videoStream({ profile: "High 4:4:4 Predictive" })] });
    expect(resolvePlaybackPlan(probe, capabilities).reasons).toEqual(["VideoProfileNotSupported"]);
  });

  it("downscales to fit maxHeight, preserving aspect ratio with even dimensions", () => {
    const probe = mediaProbe({ videoStreams: [videoStream({ width: 1920, height: 1036 })] });
    const plan = hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities(), { maxHeight: 720 }));
    expect(plan.reasons).toEqual(["VideoResolutionNotSupported"]);
    expect(plan.video).toMatchObject({ kind: "transcode", height: 720, width: 1334 });
  });

  it("caps video bitrate to what's left of maxBitrate after audio", () => {
    const probe = mediaProbe({ bitRate: 12_000_000, videoStreams: [videoStream({ bitRate: 11_500_000 })] });
    const plan = hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities({ maxBitrate: 4_000_000 })));
    expect(plan.reasons).toEqual(["ContainerBitrateExceedsLimit"]);
    expect(plan.audio?.kind).toBe("copy");
    expect(plan.video).toMatchObject({ kind: "transcode", bitrate: 4_000_000 - 192_000 });
  });

  it("never inflates a low-bitrate source past its own bitrate", () => {
    const probe = mediaProbe({ videoStreams: [videoStream({ codec: "mpeg4", bitRate: 900_000 })] });
    const plan = hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities()));
    expect(plan.video).toMatchObject({ kind: "transcode", bitrate: 900_000 });
  });

  it("downmixes surround audio to the client's HLS channel limit when transcoding it", () => {
    const probe = mediaProbe({ audioStreams: [audioStream({ codec: "dts", channels: 6 })] });
    const plan = hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities()));
    expect(plan.mode).toBe("remux");
    expect(plan.audio).toMatchObject({ kind: "transcode", codec: "aac", channels: 2 });
  });

  it("transcodes a codec the client decodes but the segment container can't carry", () => {
    const capabilities = iosLikeCapabilities({
      audioCodecs: [{ codec: "flac" }],
      hls: { ...iosLikeCapabilities().hls, segmentContainers: ["mpegts"] },
    });
    const probe = mediaProbe({ container: "mkv", audioStreams: [audioStream({ codec: "flac" })] });
    const plan = hlsPlan(resolvePlaybackPlan(probe, capabilities));
    expect(plan.reasons).toContain("AudioCodecNotSupportedInSegmentContainer");
    expect(plan.audio).toMatchObject({ kind: "transcode", codec: "aac" });
  });

  it("forceTranscode re-encodes video even when direct play would work", () => {
    const plan = hlsPlan(resolvePlaybackPlan(mediaProbe(), iosLikeCapabilities(), { forceTranscode: true }));
    expect(plan.mode).toBe("transcode");
    expect(plan.reasons).toEqual([]);
    expect(plan.video?.kind).toBe("transcode");
    expect(plan.audio?.kind).toBe("copy");
  });

  it("uses the default audio stream unless one is requested", () => {
    const probe = mediaProbe({
      audioStreams: [audioStream({ index: 1, isDefault: false }), audioStream({ index: 2, isDefault: true, codec: "ac3" })],
    });
    expect(hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities(), { forceTranscode: true })).audio?.streamIndex).toBe(2);
    expect(
      hlsPlan(resolvePlaybackPlan(probe, iosLikeCapabilities(), { forceTranscode: true, audioStreamIndex: 1 })).audio
        ?.streamIndex,
    ).toBe(1);
    expect(() => resolvePlaybackPlan(probe, iosLikeCapabilities(), { audioStreamIndex: 9 })).toThrow(/No stream/);
  });

  it("handles audio-only and video-only files", () => {
    const audioOnly = hlsPlan(resolvePlaybackPlan(mediaProbe({ container: "mkv", videoStreams: [] }), iosLikeCapabilities()));
    expect(audioOnly).toMatchObject({ mode: "remux", video: null, audio: { kind: "copy" } });
    const videoOnly = hlsPlan(resolvePlaybackPlan(mediaProbe({ container: "mkv", audioStreams: [] }), iosLikeCapabilities()));
    expect(videoOnly).toMatchObject({ mode: "remux", video: { kind: "copy" }, audio: null });
    expect(() => resolvePlaybackPlan(mediaProbe({ videoStreams: [], audioStreams: [] }), iosLikeCapabilities())).toThrow(
      /no playable/,
    );
  });

  it("fails clearly when the client offers no usable transcode codec", () => {
    const capabilities = iosLikeCapabilities({ hls: { ...iosLikeCapabilities().hls, videoCodecs: ["hevc"], segmentContainers: ["mpegts"] } });
    const probe = mediaProbe({ videoStreams: [videoStream({ codec: "mpeg4" })] });
    expect(() => resolvePlaybackPlan(probe, capabilities)).toThrow(/no transcode video codec/);
  });
});
