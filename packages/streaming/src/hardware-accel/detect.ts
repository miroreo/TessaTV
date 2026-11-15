import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscodeVideoCodec } from "../client-capabilities.js";
import { runCommand, type CommandRunner } from "../process.js";
import type { HardwareAccel, HardwareAccelKind, HardwareDecodeSupport } from "./hardware-accel.js";
import { NvencAccel, nvencDeviceId, parseNvencDeviceId, type NvencCapabilities } from "./nvenc.js";
import { SoftwareAccel } from "./software.js";
import { VaapiAccel, type VaapiCapabilities } from "./vaapi.js";

export type HardwareAccelMode = "auto" | HardwareAccelKind;

export interface HardwareAccelOptions {
  readonly ffmpegPath?: string;
  readonly vaapiDevice?: string;
  /** Let VAAPI decode on the GPU too; see `VaapiOptions`. */
  readonly vaapiHardwareDecode?: boolean;
  /** CUDA device index. */
  readonly nvencDevice?: number;
  /** Let NVENC decode on the GPU too (NVDEC). On unless `false`. */
  readonly nvencHardwareDecode?: boolean;
  readonly runner?: CommandRunner;
  /** How long one probe command may take before the device counts as unusable. Default 30s. */
  readonly probeTimeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export const DEFAULT_VAAPI_DEVICE = "/dev/dri/renderD128";

const TEST_SOURCE = ["-f", "lavfi", "-i", "testsrc2=s=256x144:r=10", "-frames:v", "3"];

const NVENC_ENCODERS: Record<TranscodeVideoCodec, string> = {
  h264: "h264_nvenc",
  hevc: "hevc_nvenc",
  av1: "av1_nvenc",
};

const VAAPI_ENCODERS: Record<TranscodeVideoCodec, string> = {
  h264: "h264_vaapi",
  hevc: "hevc_vaapi",
  av1: "av1_vaapi",
};

/** Software encoders used only to produce tiny samples for probing hardware decode support. */
const DECODE_SAMPLES: readonly (HardwareDecodeSupport & { encoder: string; pixelFormat: string })[] = [
  { codec: "h264", bitDepth: 8, encoder: "libx264", pixelFormat: "yuv420p" },
  { codec: "hevc", bitDepth: 8, encoder: "libx265", pixelFormat: "yuv420p" },
  { codec: "hevc", bitDepth: 10, encoder: "libx265", pixelFormat: "yuv420p10le" },
  { codec: "av1", bitDepth: 8, encoder: "libsvtav1", pixelFormat: "yuv420p" },
  { codec: "av1", bitDepth: 10, encoder: "libsvtav1", pixelFormat: "yuv420p10le" },
  { codec: "vp9", bitDepth: 8, encoder: "libvpx-vp9", pixelFormat: "yuv420p" },
  { codec: "vp9", bitDepth: 10, encoder: "libvpx-vp9", pixelFormat: "yuv420p10le" },
  { codec: "mpeg2video", bitDepth: 8, encoder: "mpeg2video", pixelFormat: "yuv420p" },
  { codec: "mpeg4", bitDepth: 8, encoder: "mpeg4", pixelFormat: "yuv420p" },
];

/**
 * Wraps a runner so a command that never returns rejects after `timeoutMs`. The runner's own
 * timeout isn't enough: on a wedged GPU the process sits uninterruptibly inside the driver and
 * ignores the kill, so the wait itself has to give up. Without this, one hung probe stalls
 * startup and every request that needs the device list.
 */
function withTimeout(run: CommandRunner, timeoutMs: number): CommandRunner {
  return (command, args, options) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${command} did not finish within ${timeoutMs}ms`)), timeoutMs);
    });
    const attempt = Promise.resolve().then(() => run(command, args, { ...options, timeoutMs }));
    // The loser of the race may still reject later; nobody is waiting on it by then.
    attempt.catch(() => undefined);
    return Promise.race([attempt, timedOut]).finally(() => clearTimeout(timer));
  };
}

function probeRunner(options: HardwareAccelOptions): CommandRunner {
  return withTimeout(options.runner ?? runCommand, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
}

function commandSucceeds(ffmpeg: string, run: CommandRunner) {
  return async (args: string[]): Promise<boolean> => {
    try {
      return (await run(ffmpeg, args)).exitCode === 0;
    } catch {
      return false;
    }
  };
}

/**
 * Encodes each `DECODE_SAMPLES` entry in software, then asks the GPU to decode it with
 * `hardwareArgs` + `filter`. A sample that fails to encode or decode just isn't listed.
 */
async function probeDecodeSupport(
  succeeds: (args: string[]) => Promise<boolean>,
  hardwareArgs: readonly string[],
  filter: string,
): Promise<HardwareDecodeSupport[]> {
  const sampleDirectory = await mkdtemp(join(tmpdir(), "tessatv-hwaccel-"));
  try {
    const results = await Promise.all(
      DECODE_SAMPLES.map(async (sample, position) => {
        const samplePath = join(sampleDirectory, `${position}.mkv`);
        const encoded = await succeeds([
          "-hide_banner", "-v", "error", "-y",
          ...TEST_SOURCE,
          "-pix_fmt", sample.pixelFormat,
          "-c:v", sample.encoder,
          samplePath,
        ]);
        if (!encoded) return null;
        const decoded = await succeeds([
          "-hide_banner", "-v", "error",
          ...hardwareArgs,
          "-i", samplePath,
          "-vf", filter,
          "-f", "null",
          "-",
        ]);
        return decoded ? { codec: sample.codec, bitDepth: sample.bitDepth } : null;
      }),
    );
    return results.filter((entry): entry is HardwareDecodeSupport => entry !== null);
  } finally {
    await rm(sampleDirectory, { recursive: true, force: true });
  }
}

/**
 * Probes a VAAPI device by actually running tiny encodes/decodes against it, rather than
 * trusting `ffmpeg -encoders` (which only lists what was compiled in) or a per-vendor table.
 * Returns null when the device can't encode anything.
 *
 * A decode check that fails for any reason (including a missing sample encoder) just marks
 * that codec as software-decoded — a false negative costs CPU, never a broken stream.
 */
export async function detectVaapiCapabilities(options: HardwareAccelOptions = {}): Promise<VaapiCapabilities | null> {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const run = probeRunner(options);
  const device = options.vaapiDevice ?? DEFAULT_VAAPI_DEVICE;
  const deviceArgs = ["-init_hw_device", `vaapi=va:${device}`];
  const succeeds = commandSucceeds(ffmpeg, run);

  const encodeResults = await Promise.all(
    (Object.entries(VAAPI_ENCODERS) as [TranscodeVideoCodec, string][]).map(async ([codec, encoder]) => {
      const ok = await succeeds([
        "-hide_banner", "-v", "error",
        ...deviceArgs,
        "-filter_hw_device", "va",
        ...TEST_SOURCE,
        "-vf", "format=nv12,hwupload",
        "-c:v", encoder,
        "-f", "null",
        "-",
      ]);
      return ok ? codec : null;
    }),
  );
  const encode = encodeResults.filter((codec): codec is TranscodeVideoCodec => codec !== null);
  if (encode.length === 0) return null;
  const deviceName = await vaapiDeviceName(ffmpeg, device, run);

  const decode = await probeDecodeSupport(
    succeeds,
    [...deviceArgs, "-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi"],
    "scale_vaapi=format=nv12",
  );
  return { device, deviceName, encode, decode };
}

/**
 * libva logs the driver's own description at verbose level, e.g. `VAAPI driver: Mesa Gallium
 * driver 26.1.8 for AMD Radeon 780M Graphics (radeonsi, ...)`; Mesa's names the GPU after "for".
 */
export function parseVaapiDriverName(log: string): string | null {
  const driver = /VAAPI driver: (.+?)\.?$/m.exec(log)?.[1]?.trim();
  if (!driver) return null;
  return / for (.+?) \(/.exec(driver)?.[1] ?? driver;
}

async function vaapiDeviceName(ffmpeg: string, device: string, run: CommandRunner): Promise<string | null> {
  try {
    const { stderr } = await run(ffmpeg, [
      "-hide_banner", "-v", "verbose", "-init_hw_device", `vaapi=va:${device}`,
      "-f", "lavfi", "-i", "nullsrc", "-frames:v", "1", "-f", "null", "-",
    ]);
    return parseVaapiDriverName(stderr);
  } catch {
    return null;
  }
}

/**
 * Probes an NVIDIA GPU with tiny real NVENC encodes and NVDEC decodes, like the VAAPI probe.
 * Returns null when no codec encodes (no GPU, no driver, or an ffmpeg built without NVENC).
 * Decode also needs ffmpeg's `scale_cuda`; if that's missing nothing is listed and the CPU decodes.
 */
export async function detectNvencCapabilities(options: HardwareAccelOptions = {}): Promise<NvencCapabilities | null> {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const run = probeRunner(options);
  const device = options.nvencDevice ?? 0;
  const succeeds = commandSucceeds(ffmpeg, run);

  const encodeResults = await Promise.all(
    (Object.entries(NVENC_ENCODERS) as [TranscodeVideoCodec, string][]).map(async ([codec, encoder]) => {
      const ok = await succeeds([
        "-hide_banner", "-v", "error",
        ...TEST_SOURCE,
        "-vf", "format=nv12",
        "-c:v", encoder,
        "-gpu", String(device),
        "-f", "null",
        "-",
      ]);
      return ok ? codec : null;
    }),
  );
  const encode = encodeResults.filter((codec): codec is TranscodeVideoCodec => codec !== null);
  if (encode.length === 0) return null;

  const decode = await probeDecodeSupport(
    succeeds,
    ["-init_hw_device", `cuda=cu:${device}`, "-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda"],
    "scale_cuda=format=nv12",
  );
  return { device, deviceName: await nvidiaDeviceName(device, run), encode, decode };
}

/** `nvidia-smi` is what names the GPU; absent (or failing) just means no display name. */
async function nvidiaDeviceName(device: number, run: CommandRunner): Promise<string | null> {
  try {
    const { exitCode, stdout } = await run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader", "-i", String(device)]);
    return exitCode === 0 ? stdout.trim().split("\n")[0]?.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the configured mode to a concrete strategy. `auto` tries NVENC, then VAAPI, and
 * quietly falls back to software; an explicit `nvenc`/`vaapi` that doesn't work fails loudly
 * instead of silently pinning the CPU.
 */
export async function selectHardwareAccel(
  mode: HardwareAccelMode,
  options: HardwareAccelOptions = {},
): Promise<HardwareAccel> {
  const software = new SoftwareAccel();
  if (mode === "none") return software;

  if (mode === "auto" || mode === "nvenc") {
    const nvenc = await selectNvencAccel(options, software);
    if (nvenc) return nvenc;
    if (mode === "nvenc") {
      throw new Error(`NVIDIA GPU ${options.nvencDevice ?? 0} could not encode any supported codec with NVENC`);
    }
  }

  const vaapi = await selectVaapiAccel(options, software);
  if (vaapi.accel) return vaapi.accel;
  if (mode === "vaapi") throw new Error(vaapi.error);
  return software;
}

/** NVENC only: null when the GPU can't encode anything. */
async function selectNvencAccel(options: HardwareAccelOptions, software: HardwareAccel): Promise<HardwareAccel | null> {
  const capabilities = await detectNvencCapabilities(options);
  return capabilities ? new NvencAccel(capabilities, software, { hardwareDecode: options.nvencHardwareDecode !== false }) : null;
}

/** VAAPI only, never NVENC: `error` says why not when the device is missing or can't encode. */
async function selectVaapiAccel(
  options: HardwareAccelOptions,
  software: HardwareAccel,
): Promise<{ accel: HardwareAccel; error?: never } | { accel?: never; error: string }> {
  const device = options.vaapiDevice ?? DEFAULT_VAAPI_DEVICE;
  const deviceExists = await access(device).then(
    () => true,
    () => false,
  );
  const capabilities = deviceExists ? await detectVaapiCapabilities({ ...options, vaapiDevice: device }) : null;
  if (capabilities) {
    return { accel: new VaapiAccel(capabilities, software, { hardwareDecode: options.vaapiHardwareDecode === true }) };
  }
  return {
    error: deviceExists
      ? `VAAPI device ${device} could not encode any supported codec`
      : `VAAPI device ${device} does not exist`,
  };
}

/** The VAAPI render nodes on this machine (`/dev/dri/renderD*`), in name order. */
export async function listRenderDevices(directory = "/dev/dri"): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => /^renderD\d+$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** NVIDIA GPUs on this machine as `nvenc:N` ids; empty when there's no driver or `nvidia-smi`. */
export async function listNvidiaDevices(options: Pick<HardwareAccelOptions, "runner" | "probeTimeoutMs"> = {}): Promise<string[]> {
  try {
    const { exitCode, stdout } = await probeRunner(options)("nvidia-smi", ["--query-gpu=index", "--format=csv,noheader"]);
    if (exitCode !== 0) return [];
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => nvencDeviceId(Number(line)));
  } catch {
    return [];
  }
}

/** Everything the device list can offer, in the order `auto` tries them: NVIDIA GPUs, then render nodes. */
export async function listHardwareAccelDevices(options: Pick<HardwareAccelOptions, "runner" | "probeTimeoutMs"> = {}): Promise<string[]> {
  return [...(await listNvidiaDevices(options)), ...(await listRenderDevices())];
}

/**
 * Tries each device in order and returns the first that can encode, or software when none can.
 * A device is an `nvenc:N` GPU or a VAAPI render node. An empty list means every device on the
 * machine (`listHardwareAccelDevices`). A device that fails is skipped, so a busy or broken
 * first choice never costs the user their GPU entirely.
 */
export async function selectHardwareAccelByPriority(
  devices: readonly string[],
  options: HardwareAccelOptions & { readonly onSkip?: (device: string) => void } = {},
): Promise<HardwareAccel> {
  const software = new SoftwareAccel();
  for (const device of devices.length > 0 ? devices : await listHardwareAccelDevices(options)) {
    const nvencIndex = parseNvencDeviceId(device);
    const found =
      nvencIndex === null
        ? (await selectVaapiAccel({ ...options, vaapiDevice: device }, software)).accel
        : await selectNvencAccel({ ...options, nvencDevice: nvencIndex }, software);
    if (found) return found;
    options.onSkip?.(device);
  }
  return software;
}
