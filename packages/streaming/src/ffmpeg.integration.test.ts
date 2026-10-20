// Runs the real ffmpeg/ffprobe (from the Nix dev shell) against a tiny synthesized file, so
// the arguments this package builds are proven to be accepted by ffmpeg — not just shaped
// the way the unit tests expect. Skips when ffmpeg isn't on PATH. The VAAPI case also
// skips unless the render node exists and detection finds a working encoder.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectVaapiCapabilities } from "./hardware-accel/detect.js";
import type { HardwareAccel } from "./hardware-accel/hardware-accel.js";
import { SoftwareAccel } from "./hardware-accel/software.js";
import { VaapiAccel } from "./hardware-accel/vaapi.js";
import { probeMedia } from "./media-probe.js";
import { resolvePlaybackPlan } from "./playback-plan.js";
import { runCommand } from "./process.js";
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

  it("remuxes into fMP4 HLS without re-encoding video", async () => {
    const plan = resolvePlaybackPlan(await probeMedia(samplePath), iosLikeCapabilities());
    expect(plan.mode).toBe("remux");
    const output = await runToCompletion(plan, new SoftwareAccel(), join(root, "remux"));
    expect(output.videoStreams[0]).toMatchObject({ codec: "hevc", bitDepth: 10 });
    expect(output.audioStreams[0]).toMatchObject({ codec: "ac3", channels: 6 });
  });

  const accels: [string, () => HardwareAccel][] = [["software", () => new SoftwareAccel()]];
  if (vaapi) accels.push(["vaapi", () => new VaapiAccel(vaapi, new SoftwareAccel())]);

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
