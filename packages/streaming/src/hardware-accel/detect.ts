import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscodeVideoCodec } from "../client-capabilities.js";
import { runCommand, type CommandRunner } from "../process.js";
import type { HardwareAccel, HardwareAccelKind } from "./hardware-accel.js";
import { SoftwareAccel } from "./software.js";
import { VaapiAccel, type VaapiCapabilities, type VaapiDecodeSupport } from "./vaapi.js";

export type HardwareAccelMode = "auto" | HardwareAccelKind;

export interface HardwareAccelOptions {
  readonly ffmpegPath?: string;
  readonly vaapiDevice?: string;
  /** Let VAAPI decode on the GPU too; see `VaapiOptions`. */
  readonly vaapiHardwareDecode?: boolean;
  readonly runner?: CommandRunner;
}

export const DEFAULT_VAAPI_DEVICE = "/dev/dri/renderD128";

const TEST_SOURCE = ["-f", "lavfi", "-i", "testsrc2=s=256x144:r=10", "-frames:v", "3"];

const VAAPI_ENCODERS: Record<TranscodeVideoCodec, string> = {
  h264: "h264_vaapi",
  hevc: "hevc_vaapi",
  av1: "av1_vaapi",
};

/** Software encoders used only to produce tiny samples for probing hardware decode support. */
const DECODE_SAMPLES: readonly (VaapiDecodeSupport & { encoder: string; pixelFormat: string })[] = [
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
 * Probes a VAAPI device by actually running tiny encodes/decodes against it, rather than
 * trusting `ffmpeg -encoders` (which only lists what was compiled in) or a per-vendor table.
 * Returns null when the device can't encode anything.
 *
 * A decode check that fails for any reason (including a missing sample encoder) just marks
 * that codec as software-decoded — a false negative costs CPU, never a broken stream.
 */
export async function detectVaapiCapabilities(options: HardwareAccelOptions = {}): Promise<VaapiCapabilities | null> {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const run = options.runner ?? runCommand;
  const device = options.vaapiDevice ?? DEFAULT_VAAPI_DEVICE;
  const deviceArgs = ["-hide_banner", "-v", "error", "-init_hw_device", `vaapi=va:${device}`];
  const succeeds = async (args: string[]) => {
    try {
      return (await run(ffmpeg, args)).exitCode === 0;
    } catch {
      return false;
    }
  };

  const encodeResults = await Promise.all(
    (Object.entries(VAAPI_ENCODERS) as [TranscodeVideoCodec, string][]).map(async ([codec, encoder]) => {
      const ok = await succeeds([
        ...deviceArgs,
        "-filter_hw_device",
        "va",
        ...TEST_SOURCE,
        "-vf",
        "format=nv12,hwupload",
        "-c:v",
        encoder,
        "-f",
        "null",
        "-",
      ]);
      return ok ? codec : null;
    }),
  );
  const encode = encodeResults.filter((codec): codec is TranscodeVideoCodec => codec !== null);
  if (encode.length === 0) return null;
  const deviceName = await vaapiDeviceName(ffmpeg, device, run);

  const sampleDirectory = await mkdtemp(join(tmpdir(), "tessatv-vaapi-"));
  try {
    const decodeResults = await Promise.all(
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
          ...deviceArgs,
          "-hwaccel", "vaapi",
          "-hwaccel_device", "va",
          "-hwaccel_output_format", "vaapi",
          "-i", samplePath,
          "-vf", "scale_vaapi=format=nv12",
          "-f", "null",
          "-",
        ]);
        return decoded ? { codec: sample.codec, bitDepth: sample.bitDepth } : null;
      }),
    );
    return {
      device,
      deviceName,
      encode,
      decode: decodeResults.filter((entry): entry is VaapiDecodeSupport => entry !== null),
    };
  } finally {
    await rm(sampleDirectory, { recursive: true, force: true });
  }
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
 * Resolves the configured mode to a concrete strategy. `auto` quietly falls back to
 * software; an explicit `vaapi` that doesn't work fails loudly instead of silently
 * pinning the CPU.
 */
export async function selectHardwareAccel(
  mode: HardwareAccelMode,
  options: HardwareAccelOptions = {},
): Promise<HardwareAccel> {
  const software = new SoftwareAccel();
  if (mode === "none") return software;

  const device = options.vaapiDevice ?? DEFAULT_VAAPI_DEVICE;
  const deviceExists = await access(device).then(
    () => true,
    () => false,
  );
  const capabilities = deviceExists ? await detectVaapiCapabilities({ ...options, vaapiDevice: device }) : null;
  if (capabilities) return new VaapiAccel(capabilities, software, { hardwareDecode: options.vaapiHardwareDecode === true });
  if (mode === "vaapi") {
    throw new Error(
      deviceExists
        ? `VAAPI device ${device} could not encode any supported codec`
        : `VAAPI device ${device} does not exist`,
    );
  }
  return software;
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

/**
 * Tries each device in order and returns the first that can encode, or software when none can.
 * An empty list means every render node on the machine. A device that fails is skipped, so a
 * busy or broken first choice never costs the user their GPU entirely.
 */
export async function selectHardwareAccelByPriority(
  devices: readonly string[],
  options: HardwareAccelOptions & { readonly onSkip?: (device: string) => void } = {},
): Promise<HardwareAccel> {
  for (const device of devices.length > 0 ? devices : await listRenderDevices()) {
    const accel = await selectHardwareAccel("auto", { ...options, vaapiDevice: device });
    if (accel.kind !== "none") return accel;
    options.onSkip?.(device);
  }
  return new SoftwareAccel();
}
