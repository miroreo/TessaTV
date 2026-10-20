import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommandRunner } from "../process.js";
import { videoStream } from "../test-fixtures.js";
import { detectVaapiCapabilities, selectHardwareAccel } from "./detect.js";
import type { VideoEncodeRequest } from "./hardware-accel.js";
import { SoftwareAccel } from "./software.js";
import { VaapiAccel, type VaapiCapabilities } from "./vaapi.js";

const CAPABILITIES: VaapiCapabilities = {
  device: "/dev/dri/renderD128",
  encode: ["h264", "hevc"],
  decode: [
    { codec: "h264", bitDepth: 8 },
    { codec: "hevc", bitDepth: 10 },
  ],
};

function request(overrides: Partial<VideoEncodeRequest> = {}): VideoEncodeRequest {
  return { source: videoStream(), codec: "h264", width: 1280, height: 720, bitrate: 4_000_000, ...overrides };
}

describe("SoftwareAccel", () => {
  it("scales only when dimensions change and always outputs 8-bit 4:2:0", () => {
    const accel = new SoftwareAccel();
    expect(accel.videoPipeline(request()).filters).toEqual(["scale=1280:720", "format=yuv420p"]);
    expect(accel.videoPipeline(request({ width: 1920, height: 1080 })).filters).toEqual(["format=yuv420p"]);
  });

  it("uses libx264 with capped VBR", () => {
    const pipeline = new SoftwareAccel().videoPipeline(request());
    expect(pipeline).toMatchObject({ inputArgs: [], decode: "software", encode: "software" });
    expect(pipeline.encoderArgs).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-b:v", "4000000", "-maxrate", "4000000", "-bufsize", "8000000"]),
    );
  });
});

describe("VaapiAccel", () => {
  const accel = new VaapiAccel(CAPABILITIES, new SoftwareAccel());

  it("decodes, scales, and encodes on the GPU when it supports the source", () => {
    const pipeline = accel.videoPipeline(request());
    expect(pipeline).toMatchObject({ decode: "hardware", encode: "hardware" });
    expect(pipeline.inputArgs).toEqual([
      "-init_hw_device",
      "vaapi=va:/dev/dri/renderD128",
      "-filter_hw_device",
      "va",
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "va",
      "-hwaccel_output_format",
      "vaapi",
    ]);
    expect(pipeline.filters).toEqual(["scale_vaapi=w=1280:h=720:format=nv12"]);
    expect(pipeline.encoderArgs.slice(0, 2)).toEqual(["-c:v", "h264_vaapi"]);
  });

  it("matches decode support on codec and bit depth together", () => {
    // 10-bit H.264 (Hi10P anime) isn't decodable even though 8-bit H.264 is.
    const pipeline = accel.videoPipeline(request({ source: videoStream({ bitDepth: 10 }) }));
    expect(pipeline).toMatchObject({ decode: "software", encode: "hardware" });
    expect(pipeline.inputArgs).not.toContain("-hwaccel");
    expect(pipeline.filters).toEqual(["format=nv12", "hwupload", "scale_vaapi=w=1280:h=720:format=nv12"]);
    expect(accel.canDecode("hevc", 10)).toBe(true);
    expect(accel.canDecode("hevc", 8)).toBe(false);
  });

  it("delegates a target codec the GPU can't encode to the fallback", () => {
    expect(accel.videoPipeline(request({ codec: "av1" }))).toMatchObject({ decode: "software", encode: "software" });
  });
});

describe("detectVaapiCapabilities", () => {
  /** Fakes a GPU that can encode `encoders` and decode samples whose path ends in one of `decodableSamples`. */
  function fakeGpu(encoders: string[], decodableSamples: string[]): CommandRunner {
    return async (_command, args) => {
      const encoder = args[args.indexOf("-c:v") + 1];
      const isHardwareDecode = args.includes("-hwaccel");
      const input = args[args.lastIndexOf("-i") + 1] ?? "";
      let ok: boolean;
      if (isHardwareDecode) ok = decodableSamples.some((suffix) => input.endsWith(suffix));
      else if (encoder?.endsWith("_vaapi")) ok = encoders.includes(encoder);
      else ok = true; // software sample encodes always succeed
      return { exitCode: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "unsupported" };
    };
  }

  it("records only what the device actually managed to encode and decode", async () => {
    const capabilities = await detectVaapiCapabilities({
      vaapiDevice: "/dev/dri/renderD129",
      // Sample order in detect.ts: 0=h264/8, 1=hevc/8, 2=hevc/10, ...
      runner: fakeGpu(["h264_vaapi", "hevc_vaapi"], ["/0.mkv", "/2.mkv"]),
    });
    expect(capabilities).toEqual({
      device: "/dev/dri/renderD129",
      encode: ["h264", "hevc"],
      decode: [
        { codec: "h264", bitDepth: 8 },
        { codec: "hevc", bitDepth: 10 },
      ],
    });
  });

  it("returns null when nothing encodes", async () => {
    expect(await detectVaapiCapabilities({ runner: fakeGpu([], ["/0.mkv"]) })).toBeNull();
  });

  it("treats a runner that throws (e.g. ffmpeg missing) as unsupported", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("spawn ffmpeg ENOENT");
    };
    expect(await detectVaapiCapabilities({ runner })).toBeNull();
  });
});

describe("selectHardwareAccel", () => {
  let directory: string;
  let fakeDevice: string;
  const working: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const broken: CommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "no" });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tessatv-accel-test-"));
    fakeDevice = join(directory, "renderD128");
    await writeFile(fakeDevice, "");
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  it("returns software for `none` without probing anything", async () => {
    expect((await selectHardwareAccel("none", { runner: broken })).kind).toBe("none");
  });

  it("picks VAAPI under `auto` when the device works", async () => {
    expect((await selectHardwareAccel("auto", { vaapiDevice: fakeDevice, runner: working })).kind).toBe("vaapi");
  });

  it("falls back to software under `auto` when the device is missing or broken", async () => {
    expect((await selectHardwareAccel("auto", { vaapiDevice: join(directory, "missing"), runner: working })).kind).toBe(
      "none",
    );
    expect((await selectHardwareAccel("auto", { vaapiDevice: fakeDevice, runner: broken })).kind).toBe("none");
  });

  it("fails loudly when `vaapi` is explicitly requested but unusable", async () => {
    await expect(selectHardwareAccel("vaapi", { vaapiDevice: join(directory, "missing") })).rejects.toThrow(
      /does not exist/,
    );
    await expect(selectHardwareAccel("vaapi", { vaapiDevice: fakeDevice, runner: broken })).rejects.toThrow(
      /could not encode/,
    );
  });
});
