import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommandRunner } from "../process.js";
import { videoStream } from "../test-fixtures.js";
import {
  detectNvencCapabilities,
  detectVaapiCapabilities,
  listNvidiaDevices,
  listRenderDevices,
  parseVaapiDriverName,
  selectHardwareAccel,
  selectHardwareAccelByPriority,
} from "./detect.js";
import type { VideoEncodeRequest } from "./hardware-accel.js";
import { NvencAccel, type NvencCapabilities } from "./nvenc.js";
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
  const accel = new VaapiAccel(CAPABILITIES, new SoftwareAccel(), { hardwareDecode: true });

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

  it("decodes on the CPU unless hardware decode is enabled, even for a supported source", () => {
    const cpuDecode = new VaapiAccel(CAPABILITIES, new SoftwareAccel());
    const pipeline = cpuDecode.videoPipeline(request());
    expect(pipeline).toMatchObject({ decode: "software", encode: "hardware" });
    expect(pipeline.inputArgs).not.toContain("-hwaccel");
    expect(pipeline.filters).toEqual(["format=nv12", "hwupload", "scale_vaapi=w=1280:h=720:format=nv12"]);
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

const NVENC_CAPABILITIES: NvencCapabilities = {
  device: 1,
  encode: ["h264", "hevc"],
  decode: [
    { codec: "h264", bitDepth: 8 },
    { codec: "hevc", bitDepth: 10 },
  ],
};

describe("NvencAccel", () => {
  const accel = new NvencAccel(NVENC_CAPABILITIES, new SoftwareAccel());
  const hdr = { source: videoStream({ codec: "hevc", bitDepth: 10, isHdr: true }), codec: "h264" as const, width: 1920, height: 1080, bitrate: 8_000_000 };

  it("decodes with NVDEC, scales on the GPU, and encodes with NVENC by default", () => {
    const pipeline = accel.videoPipeline(request());
    expect(pipeline).toMatchObject({ decode: "hardware", encode: "hardware" });
    expect(pipeline.inputArgs).toEqual([
      "-init_hw_device", "cuda=cu:1", "-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda",
    ]);
    expect(pipeline.filters).toEqual(["scale_cuda=w=1280:h=720:format=nv12"]);
    expect(pipeline.encoderArgs).toEqual(
      expect.arrayContaining(["-c:v", "h264_nvenc", "-gpu", "1", "-rc", "vbr", "-b:v", "4000000"]),
    );
  });

  it("decodes on the CPU when disabled or the codec + bit depth isn't supported, with no upload needed", () => {
    const disabled = new NvencAccel(NVENC_CAPABILITIES, new SoftwareAccel(), { hardwareDecode: false }).videoPipeline(request());
    expect(disabled).toMatchObject({ decode: "software", encode: "hardware", inputArgs: [], filters: ["scale=1280:720", "format=nv12"] });
    expect(accel.videoPipeline(request({ source: videoStream({ bitDepth: 10 }) })).decode).toBe("software");
  });

  it("tone-maps in software, downloading only frames already scaled on the GPU", () => {
    const pipeline = accel.videoPipeline(hdr);
    expect(pipeline.filters.slice(0, 3)).toEqual(["scale_cuda=w=1920:h=1080:format=p010le", "hwdownload", "format=p010le"]);
    expect(pipeline.filters).toContain("tonemap=tonemap=hable:desat=0");
    expect(pipeline.postOverlayFilters).toEqual([]);
    expect(pipeline.encoderArgs).toEqual(expect.arrayContaining(["-color_trc", "bt709"]));
  });

  it("downloads GPU frames for subtitle burn-in", () => {
    const pipeline = accel.videoPipeline(request({ burnIn: true }));
    expect(pipeline.filters).toEqual(["scale_cuda=w=1280:h=720:format=nv12", "hwdownload", "format=nv12"]);
    expect(pipeline.postOverlayFilters).toEqual(["format=nv12"]);
  });

  it("delegates a target codec the GPU can't encode to the fallback", () => {
    expect(accel.videoPipeline(request({ codec: "av1" }))).toMatchObject({ decode: "software", encode: "software" });
  });
});

describe("detectNvencCapabilities", () => {
  function fakeNvidia(encoders: string[], decodableSamples: string[]): CommandRunner {
    return async (command, args) => {
      if (command === "nvidia-smi") return { exitCode: 0, stdout: "NVIDIA GeForce RTX 3060\n", stderr: "" };
      const encoder = args[args.indexOf("-c:v") + 1];
      const input = args[args.lastIndexOf("-i") + 1] ?? "";
      let ok: boolean;
      if (args.includes("-hwaccel")) ok = decodableSamples.some((suffix) => input.endsWith(suffix));
      else if (encoder?.endsWith("_nvenc")) ok = encoders.includes(encoder);
      else ok = true;
      return { exitCode: ok ? 0 : 1, stdout: "", stderr: "" };
    };
  }

  it("records what the GPU actually encodes and decodes, and its name", async () => {
    expect(
      await detectNvencCapabilities({ nvencDevice: 1, runner: fakeNvidia(["h264_nvenc", "av1_nvenc"], ["/0.mkv"]) }),
    ).toEqual({
      device: 1,
      deviceName: "NVIDIA GeForce RTX 3060",
      encode: ["h264", "av1"],
      decode: [{ codec: "h264", bitDepth: 8 }],
    });
  });

  it("returns null when nothing encodes or the runner throws", async () => {
    expect(await detectNvencCapabilities({ runner: fakeNvidia([], ["/0.mkv"]) })).toBeNull();
    const throwing: CommandRunner = async () => {
      throw new Error("spawn ffmpeg ENOENT");
    };
    expect(await detectNvencCapabilities({ runner: throwing })).toBeNull();
  });
});

describe("parseVaapiDriverName", () => {
  it("takes the GPU name out of the driver's description", () => {
    const mesa =
      "[VAAPI @ 0x5] VAAPI driver: Mesa Gallium driver 26.1.8 for AMD Radeon 780M Graphics (radeonsi, phoenix, ACO, DRM 3.64, 7.2.9).";
    expect(parseVaapiDriverName(`[VAAPI @ 0x5] Initialised VAAPI connection: version 1.24\n${mesa}\n`)).toBe(
      "AMD Radeon 780M Graphics",
    );
    expect(parseVaapiDriverName("[VAAPI @ 0x5] VAAPI driver: Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()")).toBe(
      "Intel(R) Gen Graphics - 24.1.0",
    );
    expect(parseVaapiDriverName("[VAAPI @ 0x5] VAAPI driver: Splitted-Desktop Systems VDPAU backend")).toBe(
      "Splitted-Desktop Systems VDPAU backend",
    );
    expect(parseVaapiDriverName("nothing useful")).toBeNull();
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
      deviceName: null,
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
  /** A machine with a working VAAPI device and no NVIDIA GPU. */
  const vaapiOnly: CommandRunner = async (_command, args) =>
    args.includes("-gpu") || args.includes("cuda") ? { exitCode: 1, stdout: "", stderr: "no" } : { exitCode: 0, stdout: "", stderr: "" };

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
    expect((await selectHardwareAccel("auto", { vaapiDevice: fakeDevice, runner: vaapiOnly })).kind).toBe("vaapi");
  });

  it("falls back to software under `auto` when the device is missing or broken", async () => {
    expect((await selectHardwareAccel("auto", { vaapiDevice: join(directory, "missing"), runner: vaapiOnly })).kind).toBe(
      "none",
    );
    expect((await selectHardwareAccel("auto", { vaapiDevice: fakeDevice, runner: broken })).kind).toBe("none");
  });

  it("prefers NVENC over VAAPI under `auto`, and falls through to VAAPI when NVENC fails", async () => {
    expect((await selectHardwareAccel("auto", { vaapiDevice: fakeDevice, runner: working })).kind).toBe("nvenc");
    expect((await selectHardwareAccel("auto", { vaapiDevice: fakeDevice, runner: vaapiOnly })).kind).toBe("vaapi");
  });

  it("tries only VAAPI devices when choosing by priority, even where NVENC would work", async () => {
    const accel = await selectHardwareAccelByPriority([fakeDevice], { runner: working });
    expect(accel).toMatchObject({ kind: "vaapi", capabilities: { device: fakeDevice } });
  });

  it("fails loudly when `nvenc` is explicitly requested but unusable", async () => {
    await expect(selectHardwareAccel("nvenc", { runner: broken })).rejects.toThrow(/NVENC/);
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

describe("selectHardwareAccelByPriority", () => {
  let directory: string;
  const [first, second] = ["renderD128", "renderD129"];
  /** Only the second device's probes succeed. */
  const onlySecond: CommandRunner = async (_command, args) => ({
    exitCode: args.some((arg) => arg.includes(second!)) ? 0 : 1,
    stdout: "",
    stderr: "",
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tessatv-accel-priority-"));
    await Promise.all([first!, second!, "card0"].map((name) => writeFile(join(directory, name), "")));
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  it("uses the first device in the list that works, skipping ones that fail", async () => {
    const skipped: string[] = [];
    const accel = await selectHardwareAccelByPriority([join(directory, first!), join(directory, second!)], { runner: onlySecond, onSkip: (device) => skipped.push(device) });
    expect(accel).toMatchObject({ kind: "vaapi", device: join(directory, second!) });
    expect(skipped).toEqual([join(directory, first!)]);
  });

  it("honours the order: a working first choice wins over a working second", async () => {
    const working: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const accel = await selectHardwareAccelByPriority([join(directory, second!), join(directory, first!)], { runner: working });
    expect(accel).toMatchObject({ device: join(directory, second!) });
  });

  it("falls back to software when no listed device works", async () => {
    const broken: CommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    expect((await selectHardwareAccelByPriority([join(directory, first!)], { runner: broken })).kind).toBe("none");
  });

  it("tries an NVIDIA GPU as `nvenc:N`, and skips it for the next device when it fails", async () => {
    const noNvidia: CommandRunner = async (_command, args) => ({
      exitCode: args.includes("-gpu") || args.includes("cuda") ? 1 : 0,
      stdout: "",
      stderr: "",
    });
    const working: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const skipped: string[] = [];
    expect(await selectHardwareAccelByPriority(["nvenc:1", join(directory, first!)], { runner: working })).toMatchObject({
      kind: "nvenc",
      device: "nvenc:1",
    });
    expect(
      await selectHardwareAccelByPriority(["nvenc:0", join(directory, first!)], { runner: noNvidia, onSkip: (device) => skipped.push(device) }),
    ).toMatchObject({ kind: "vaapi", device: join(directory, first!) });
    expect(skipped).toEqual(["nvenc:0"]);
  });

  it("lists NVIDIA GPUs by index, and none without a driver", async () => {
    const smi: CommandRunner = async () => ({ exitCode: 0, stdout: "0\n1\n", stderr: "" });
    expect(await listNvidiaDevices({ runner: smi })).toEqual(["nvenc:0", "nvenc:1"]);
    expect(await listNvidiaDevices({ runner: async () => ({ exitCode: 9, stdout: "", stderr: "" }) })).toEqual([]);
    expect(
      await listNvidiaDevices({
        runner: async () => {
          throw new Error("spawn nvidia-smi ENOENT");
        },
      }),
    ).toEqual([]);
  });

  describe("with a GPU that never answers", () => {
    // A wedged GPU leaves the probe process stuck in the driver, so the runner never returns.
    const calls: { command: string; timeoutMs: number | undefined }[] = [];
    const hung: CommandRunner = (command, _args, options) => {
      calls.push({ command, timeoutMs: options?.timeoutMs });
      return new Promise(() => undefined);
    };

    it("treats the device as unusable instead of waiting forever, and moves on", async () => {
      const skipped: string[] = [];
      const accel = await selectHardwareAccelByPriority([join(directory, first!)], {
        runner: hung,
        probeTimeoutMs: 20,
        onSkip: (device) => skipped.push(device),
      });
      expect(accel.kind).toBe("none");
      expect(skipped).toEqual([join(directory, first!)]);
      expect(calls[0]).toMatchObject({ command: "ffmpeg", timeoutMs: 20 });
    });

    it("gives up on `nvidia-smi` and on a capability probe too", async () => {
      expect(await listNvidiaDevices({ runner: hung, probeTimeoutMs: 20 })).toEqual([]);
      expect(await detectNvencCapabilities({ runner: hung, probeTimeoutMs: 20 })).toBeNull();
      expect(await detectVaapiCapabilities({ runner: hung, probeTimeoutMs: 20 })).toBeNull();
    });
  });

  it("lists render nodes in name order, ignoring other entries", async () => {
    expect(await listRenderDevices(directory)).toEqual([join(directory, first!), join(directory, second!)]);
    expect(await listRenderDevices(join(directory, "missing"))).toEqual([]);
  });
});

describe("HDR tone-mapping", () => {
  const hdrSource = videoStream({ codec: "hevc", bitDepth: 10, width: 3840, height: 2160, isHdr: true });
  const hdr = { source: hdrSource, codec: "h264" as const, width: 1920, height: 1080, bitrate: 8_000_000 };

  it("tone-maps in software and tags the output as BT.709", () => {
    const pipeline = new SoftwareAccel().videoPipeline(hdr);
    expect(pipeline.filters[0]).toBe("zscale=w=1920:h=1080:t=linear:npl=100");
    expect(pipeline.filters).toContain("tonemap=tonemap=hable:desat=0");
    expect(pipeline.filters.at(-1)).toBe("format=yuv420p");
    expect(pipeline.encoderArgs).toEqual(expect.arrayContaining(["-color_trc", "bt709"]));
  });

  it("with VAAPI, scales on the GPU and uploads the tone-mapped frames back", () => {
    const vaapi = new VaapiAccel(
      { device: "/dev/dri/renderD128", encode: ["h264"], decode: [{ codec: "hevc", bitDepth: 10 }] },
      new SoftwareAccel(),
      { hardwareDecode: true },
    );
    const pipeline = vaapi.videoPipeline(hdr);
    expect(pipeline.decode).toBe("hardware");
    expect(pipeline.filters.slice(0, 3)).toEqual(["scale_vaapi=w=1920:h=1080:format=p010", "hwdownload", "format=p010le"]);
    expect(pipeline.postOverlayFilters).toEqual(["hwupload"]);
    expect(pipeline.encode).toBe("hardware");
  });

  it("with VAAPI but no hardware decode for the source, skips the GPU scale and download", () => {
    const vaapi = new VaapiAccel({ device: "/dev/dri/renderD128", encode: ["h264"], decode: [] }, new SoftwareAccel());
    const pipeline = vaapi.videoPipeline(hdr);
    expect(pipeline.decode).toBe("software");
    expect(pipeline.filters).not.toContain("hwdownload");
  });

  it("leaves SDR sources untouched", () => {
    const pipeline = new SoftwareAccel().videoPipeline({ ...hdr, source: { ...hdrSource, isHdr: false } });
    expect(pipeline.filters.join()).not.toContain("tonemap");
    expect(pipeline.encoderArgs).not.toContain("-color_trc");
  });
});
