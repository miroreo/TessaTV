import { cpus } from "node:os";
import type { TranscodeVideoCodec } from "../client-capabilities.js";
import { rateControlArgs, SDR_COLOR_ARGS, toneMapFilters, type HardwareAccel, type VideoEncodeRequest, type VideoPipeline } from "./hardware-accel.js";

const ENCODER_ARGS: Record<TranscodeVideoCodec, readonly string[]> = {
  h264: ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high"],
  hevc: ["-c:v", "libx265", "-preset", "veryfast", "-x265-params", "log-level=error"],
  av1: ["-c:v", "libsvtav1", "-preset", "10"],
};

/** The CPU's marketing name (e.g. `AMD Ryzen 7 7840HS w/ Radeon 780M Graphics`), as the kernel reports it. */
export function cpuModel(): string | null {
  return cpus()[0]?.model.trim() || null;
}

/** CPU decode + encode. Always available; also the fallback other strategies delegate to. */
export class SoftwareAccel implements HardwareAccel {
  readonly kind = "none";
  readonly deviceName = cpuModel();

  videoPipeline(request: VideoEncodeRequest): VideoPipeline {
    const { source, width, height } = request;
    const scale = source.width !== width || source.height !== height ? [`scale=${width}:${height}`] : [];
    return {
      inputArgs: [],
      // 8-bit 4:2:0 output: the widest-compatible choice, and it converts 10-bit sources.
      filters: source.isHdr ? toneMapFilters(width, height, "yuv420p") : [...scale, "format=yuv420p"],
      postOverlayFilters: [],
      encoderArgs: [
        ...ENCODER_ARGS[request.codec],
        ...rateControlArgs(request.bitrate),
        ...(source.isHdr ? SDR_COLOR_ARGS : []),
      ],
      decode: "software",
      encode: "software",
    };
  }
}
