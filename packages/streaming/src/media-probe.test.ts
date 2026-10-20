import { describe, expect, it } from "vitest";
import { normalizeContainer, parseFfprobeOutput, probeMedia } from "./media-probe.js";
import type { CommandRunner } from "./process.js";

/** Trimmed from real `ffprobe -show_format -show_streams` output of an anime BluRay rip. */
const MKV_FIXTURE = {
  streams: [
    {
      index: 0,
      codec_name: "hevc",
      codec_type: "video",
      profile: "Main 10",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p10le",
      avg_frame_rate: "24000/1001",
      r_frame_rate: "24000/1001",
      color_transfer: "bt709",
      disposition: { default: 1, attached_pic: 0 },
      tags: { language: "jpn" },
    },
    {
      index: 1,
      codec_name: "opus",
      codec_type: "audio",
      channels: 2,
      channel_layout: "stereo",
      sample_rate: "48000",
      disposition: { default: 0 },
      tags: { language: "eng", title: "English" },
    },
    {
      index: 2,
      codec_name: "aac",
      codec_type: "audio",
      profile: "LC",
      channels: 6,
      channel_layout: "5.1",
      sample_rate: "48000",
      bit_rate: "384000",
      disposition: { default: 1 },
      tags: { language: "jpn" },
    },
    {
      index: 3,
      codec_name: "subrip",
      codec_type: "subtitle",
      disposition: { default: 1, forced: 1 },
      tags: { language: "eng" },
    },
    { index: 4, codec_name: "hdmv_pgs_subtitle", codec_type: "subtitle", disposition: { default: 0 } },
    {
      index: 5,
      codec_name: "mjpeg",
      codec_type: "video",
      width: 600,
      height: 600,
      disposition: { default: 0, attached_pic: 1 },
    },
  ],
  format: { format_name: "matroska,webm", duration: "1420.512000", size: "512000000", bit_rate: "2883000" },
};

describe("parseFfprobeOutput", () => {
  const probe = parseFfprobeOutput("/media/show.mkv", MKV_FIXTURE);

  it("maps format-level fields", () => {
    expect(probe).toMatchObject({
      path: "/media/show.mkv",
      container: "mkv",
      durationSeconds: 1420.512,
      bitRate: 2883000,
      sizeBytes: 512000000,
    });
  });

  it("derives bit depth from the pixel format and skips embedded cover art", () => {
    expect(probe.videoStreams).toHaveLength(1);
    expect(probe.videoStreams[0]).toMatchObject({
      index: 0,
      codec: "hevc",
      profile: "Main 10",
      bitDepth: 10,
      isHdr: false,
      isDefault: true,
      language: "jpn",
    });
    expect(probe.videoStreams[0]?.frameRate).toBeCloseTo(23.976, 3);
  });

  it("flags PQ/HLG transfers as HDR", () => {
    const hdr = parseFfprobeOutput("/x.mkv", {
      streams: [{ ...MKV_FIXTURE.streams[0], color_transfer: "smpte2084" }],
      format: MKV_FIXTURE.format,
    });
    expect(hdr.videoStreams[0]?.isHdr).toBe(true);
  });

  it("keeps absolute stream indexes and audio details", () => {
    expect(probe.audioStreams.map((stream) => [stream.index, stream.codec, stream.channels])).toEqual([
      [1, "opus", 2],
      [2, "aac", 6],
    ]);
    expect(probe.audioStreams[0]).toMatchObject({ title: "English", bitRate: null, sampleRate: 48000 });
  });

  it("distinguishes text from image subtitles", () => {
    expect(probe.subtitleStreams).toEqual([
      expect.objectContaining({ index: 3, codec: "subrip", isTextBased: true, isForced: true }),
      expect.objectContaining({ index: 4, codec: "hdmv_pgs_subtitle", isTextBased: false, language: null }),
    ]);
  });

  it("treats N/A and missing values as null", () => {
    const sparse = parseFfprobeOutput("/x.avi", { streams: [], format: { format_name: "avi", duration: "N/A" } });
    expect(sparse).toMatchObject({ container: "avi", durationSeconds: null, bitRate: null, sizeBytes: null });
  });
});

describe("normalizeContainer", () => {
  it.each([
    ["matroska,webm", "/a.mkv", "mkv"],
    ["matroska,webm", "/a.WEBM", "webm"],
    ["mov,mp4,m4a,3gp,3g2,mj2", "/a.mp4", "mp4"],
    ["mov,mp4,m4a,3gp,3g2,mj2", "/a.m4v", "m4v"],
    ["mov,mp4,m4a,3gp,3g2,mj2", "/a.mov", "mov"],
    ["mpegts", "/a.m2ts", "ts"],
    ["avi", "/a.avi", "avi"],
  ])("%s + %s -> %s", (formatName, path, expected) => {
    expect(normalizeContainer(formatName, path)).toBe(expected);
  });
});

describe("probeMedia", () => {
  it("runs ffprobe with JSON output and parses it", async () => {
    const calls: [string, readonly string[]][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, args]);
      return { exitCode: 0, stdout: JSON.stringify(MKV_FIXTURE), stderr: "" };
    };
    const probe = await probeMedia("/media/show.mkv", { runner, ffprobePath: "/bin/ffprobe" });
    expect(probe.container).toBe("mkv");
    expect(calls[0]?.[0]).toBe("/bin/ffprobe");
    expect(calls[0]?.[1]).toEqual(expect.arrayContaining(["-show_format", "-show_streams", "/media/show.mkv"]));
  });

  it("surfaces ffprobe's stderr on failure", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "EBML header parsing failed\n" });
    await expect(probeMedia("/empty.mkv", { runner })).rejects.toThrow(/EBML header parsing failed/);
  });
});
