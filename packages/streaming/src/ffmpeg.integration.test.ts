// Runs the real ffmpeg/ffprobe (from the Nix dev shell) against a tiny synthesized file, so
// the arguments this package builds are proven to be accepted by ffmpeg — not just shaped
// the way the unit tests expect. Skips when ffmpeg isn't on PATH. The VAAPI case also
// skips unless the render node exists and detection finds a working encoder.
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkFileHealth } from "./file-health.js";
import { detectVaapiCapabilities } from "./hardware-accel/detect.js";
import type { HardwareAccel } from "./hardware-accel/hardware-accel.js";
import { SoftwareAccel } from "./hardware-accel/software.js";
import { VaapiAccel } from "./hardware-accel/vaapi.js";
import { probeMedia } from "./media-probe.js";
import { resolvePlaybackPlan } from "./playback-plan.js";
import { runCommand } from "./process.js";
import { extractWebVtt } from "./subtitles.js";
import { iosLikeCapabilities } from "./test-fixtures.js";
import { startTranscodeSession } from "./transcode-session.js";

const ffmpegAvailable = await runCommand("ffmpeg", ["-version"]).then(
  (result) => result.exitCode === 0,
  () => false,
);
const vaapi = ffmpegAvailable ? await detectVaapiCapabilities() : null;

describe.skipIf(!ffmpegAvailable)("streaming against real ffmpeg", () => {
  let root: string;
  let samplePath: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tessatv-ffmpeg-test-"));
    samplePath = join(root, "sample.mkv");
    // 4s of 10-bit HEVC + 5.1 AC-3 in Matroska: unplayable as-is by the iOS-like profile on
    // every axis we model (container, bit depth via forced transcode, surround downmix).
    const result = await runCommand("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=4",
      "-f", "lavfi", "-i", "sine=f=440:d=4",
      "-filter_complex", "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]",
      "-map", "0:v", "-map", "[a]",
      "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error",
      "-c:a", "ac3",
      samplePath,
    ]);
    if (result.exitCode !== 0) throw new Error(`Couldn't synthesize sample: ${result.stderr}`);
  }, 60_000);
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("probes the synthesized file", async () => {
    const probe = await probeMedia(samplePath);
    expect(probe.container).toBe("mkv");
    expect(probe.durationSeconds).toBeCloseTo(4, 0);
    expect(probe.videoStreams[0]).toMatchObject({ codec: "hevc", bitDepth: 10, width: 640, height: 360 });
    expect(probe.audioStreams[0]).toMatchObject({ codec: "ac3", channels: 6 });
  });

  it("decode-checks a clean file, reporting progress, and flags one with a corrupted stretch", async () => {
    const positions: number[] = [];
    const clean = await checkFileHealth(samplePath, { readRate: 100, onProgress: ({ outTimeSeconds }) => positions.push(outTimeSeconds) });
    expect(clean).toMatchObject({ severity: "clean", error: null });
    expect(positions.length).toBeGreaterThan(0);
    expect(Math.max(...positions)).toBeCloseTo(4, 0);

    const bytes = await readFile(samplePath);
    const damagedPath = join(root, "damaged.mkv");
    randomBytes(4000).copy(bytes, Math.floor(bytes.length / 2));
    await writeFile(damagedPath, bytes);
    expect(await checkFileHealth(damagedPath, { readRate: 100 })).toMatchObject({ error: expect.any(String), severity: expect.stringMatching(/minor|major/) });
  });

  it("remuxes into fMP4 HLS without re-encoding video", async () => {
    const plan = resolvePlaybackPlan(await probeMedia(samplePath), iosLikeCapabilities());
    expect(plan.mode).toBe("remux");
    const output = await runToCompletion(plan, new SoftwareAccel(), join(root, "remux"));
    expect(output.videoStreams[0]).toMatchObject({ codec: "hevc", bitDepth: 10 });
    expect(output.audioStreams[0]).toMatchObject({ codec: "ac3", channels: 6 });
  });

  const accels: [string, () => HardwareAccel][] = [["software", () => new SoftwareAccel()]];
  if (vaapi) {
    accels.push(["vaapi (CPU decode)", () => new VaapiAccel(vaapi, new SoftwareAccel())]);
    accels.push(["vaapi (GPU decode)", () => new VaapiAccel(vaapi, new SoftwareAccel(), { hardwareDecode: true })]);
  }

  it.each(accels)("transcodes to 8-bit H.264 + stereo AAC with %s", async (name, makeAccel) => {
    const plan = resolvePlaybackPlan(await probeMedia(samplePath), iosLikeCapabilities({ audioCodecs: [] }), {
      forceTranscode: true,
      maxHeight: 240,
    });
    const output = await runToCompletion(plan, makeAccel(), join(root, name));
    expect(output.videoStreams[0]).toMatchObject({ codec: "h264", bitDepth: 8, width: 426, height: 240 });
    expect(output.audioStreams[0]).toMatchObject({ codec: "aac", channels: 2 });
    expect(output.durationSeconds).toBeCloseTo(4, 0);
  }, 60_000);

  it.each(accels)("tone-maps PQ HDR to tagged 8-bit SDR with %s", async (name, makeAccel) => {
    const hdrPath = join(root, "hdr.mkv");
    const synthesized = await runCommand("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=2",
      // Colors aren't truly PQ — only the tags matter to what's under test here.
      "-pix_fmt", "yuv420p10le",
      "-c:v", "libx265", "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
      hdrPath,
    ]);
    if (synthesized.exitCode !== 0) throw new Error(`Couldn't synthesize HDR sample: ${synthesized.stderr}`);
    const probe = await probeMedia(hdrPath);
    expect(probe.videoStreams[0]?.isHdr).toBe(true);

    const output = await runToCompletion(resolvePlaybackPlan(probe, iosLikeCapabilities()), makeAccel(), join(root, `hdr-${name}`));
    expect(output.videoStreams[0]).toMatchObject({ codec: "h264", bitDepth: 8, isHdr: false });
  }, 60_000);

  it("extracts text subtitles as WebVTT", async () => {
    const srtPath = join(root, "subs.srt");
    await writeFile(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nHello there\n");
    const mkvPath = join(root, "with-subs.mkv");
    const muxed = await runCommand("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", samplePath, "-i", srtPath, "-map", "0", "-map", "1", "-c", "copy", mkvPath]);
    if (muxed.exitCode !== 0) throw new Error(`Couldn't mux subtitles: ${muxed.stderr}`);
    const subtitle = (await probeMedia(mkvPath)).subtitleStreams[0]!;
    const vtt = await extractWebVtt(mkvPath, subtitle.index);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:01.000 --> 00:02.000");
    expect(vtt).toContain("Hello there");
  });

  async function runToCompletion(
    plan: ReturnType<typeof resolvePlaybackPlan>,
    accel: HardwareAccel,
    directory: string,
  ) {
    const session = await startTranscodeSession(plan, { accel, directory });
    const result = await session.done;
    expect(result).toEqual({ state: "completed", error: null });
    expect((await readdir(directory)).some((file) => file.startsWith("segment"))).toBe(true);
    return probeMedia(session.playlistPath);
  }
});
