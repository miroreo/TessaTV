import { describe, expect, it } from "vitest";
import { buildTranscodeArgs } from "./ffmpeg-args.js";
import { SoftwareAccel } from "./hardware-accel/software.js";
import { VaapiAccel } from "./hardware-accel/vaapi.js";
import type { HlsPlaybackPlan } from "./playback-plan.js";
import { videoStream } from "./test-fixtures.js";

const source = videoStream({ codec: "hevc", bitDepth: 10 });

const TRANSCODE_PLAN: HlsPlaybackPlan = {
  mode: "transcode",
  path: "/media/show.mkv",
  segmentContainer: "fmp4",
  video: { kind: "transcode", streamIndex: 0, source, codec: "h264", width: 1280, height: 720, bitrate: 4_000_000 },
  audio: { kind: "transcode", streamIndex: 2, codec: "aac", channels: 2, bitrate: 192_000 },
  reasons: ["VideoCodecNotSupported"],
};

const REMUX_PLAN: HlsPlaybackPlan = {
  mode: "remux",
  path: "/media/show.mkv",
  segmentContainer: "fmp4",
  video: { kind: "copy", streamIndex: 0, codec: "hevc" },
  audio: { kind: "copy", streamIndex: 1, codec: "aac" },
  reasons: ["ContainerNotSupported"],
};

function valueAfter(args: string[], flag: string): string | undefined {
  const position = args.indexOf(flag);
  return position < 0 ? undefined : args[position + 1];
}

describe("buildTranscodeArgs", () => {
  it("maps the chosen streams and drops subtitles/data", () => {
    const args = buildTranscodeArgs(TRANSCODE_PLAN, new SoftwareAccel(), { directory: "/tmp/s" });
    expect(args.filter((_, i) => args[i - 1] === "-map")).toEqual(["0:0", "0:2"]);
    expect(args).toEqual(expect.arrayContaining(["-sn", "-dn"]));
  });

  it("re-encodes audio with the planned codec, channels, and bitrate", () => {
    const args = buildTranscodeArgs(TRANSCODE_PLAN, new SoftwareAccel(), { directory: "/tmp/s" });
    expect(valueAfter(args, "-c:a")).toBe("aac");
    expect(valueAfter(args, "-ac")).toBe("2");
    expect(valueAfter(args, "-b:a")).toBe("192000");
  });

  it("forces keyframes on segment boundaries when encoding", () => {
    const args = buildTranscodeArgs(TRANSCODE_PLAN, new SoftwareAccel(), { directory: "/tmp/s", segmentSeconds: 4 });
    expect(valueAfter(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*4)");
    expect(valueAfter(args, "-hls_time")).toBe("4");
  });

  it("writes fMP4 segments with an init file into the output directory", () => {
    const args = buildTranscodeArgs(TRANSCODE_PLAN, new SoftwareAccel(), { directory: "/tmp/s" });
    expect(valueAfter(args, "-hls_segment_type")).toBe("fmp4");
    expect(valueAfter(args, "-hls_fmp4_init_filename")).toBe("init.mp4");
    expect(valueAfter(args, "-hls_segment_filename")).toBe("/tmp/s/segment%05d.m4s");
    expect(args.at(-1)).toBe("/tmp/s/index.m3u8");
  });

  it("writes MPEG-TS segments without an init file", () => {
    const plan: HlsPlaybackPlan = { ...TRANSCODE_PLAN, segmentContainer: "mpegts" };
    const args = buildTranscodeArgs(plan, new SoftwareAccel(), { directory: "/tmp/s" });
    expect(args).not.toContain("-hls_fmp4_init_filename");
    expect(valueAfter(args, "-hls_segment_filename")).toBe("/tmp/s/segment%05d.ts");
  });

  it("puts the strategy's input args and the seek before -i", () => {
    const accel = new VaapiAccel(
      { device: "/dev/dri/renderD128", encode: ["h264"], decode: [{ codec: "hevc", bitDepth: 10 }] },
      new SoftwareAccel(),
    );
    const args = buildTranscodeArgs(TRANSCODE_PLAN, accel, { directory: "/tmp/s", startTimeSeconds: 90 });
    const input = args.indexOf("-i");
    expect(args.indexOf("-hwaccel")).toBeLessThan(input);
    expect(args.indexOf("-ss")).toBeLessThan(input);
    expect(valueAfter(args, "-ss")).toBe("90");
    expect(valueAfter(args, "-vf")).toBe("scale_vaapi=w=1280:h=720:format=nv12");
    expect(valueAfter(args, "-c:v")).toBe("h264_vaapi");
  });

  it("copies streams for a remux, with no filters or forced keyframes", () => {
    const args = buildTranscodeArgs(REMUX_PLAN, new SoftwareAccel(), { directory: "/tmp/s" });
    expect(valueAfter(args, "-c:v")).toBe("copy");
    expect(valueAfter(args, "-c:a")).toBe("copy");
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-force_key_frames");
    expect(args).not.toContain("-ss");
  });

  it("tags HEVC as hvc1 in fMP4 so Apple players accept it", () => {
    expect(valueAfter(buildTranscodeArgs(REMUX_PLAN, new SoftwareAccel(), { directory: "/tmp/s" }), "-tag:v")).toBe(
      "hvc1",
    );
    expect(buildTranscodeArgs(TRANSCODE_PLAN, new SoftwareAccel(), { directory: "/tmp/s" })).not.toContain("-tag:v");
  });
});
