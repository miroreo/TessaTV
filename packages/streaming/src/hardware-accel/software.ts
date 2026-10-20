import type { TranscodeVideoCodec } from "../client-capabilities.js";
import { rateControlArgs, type HardwareAccel, type VideoEncodeRequest, type VideoPipeline } from "./hardware-accel.js";

const ENCODER_ARGS: Record<TranscodeVideoCodec, readonly string[]> = {
  h264: ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high"],
  hevc: ["-c:v", "libx265", "-preset", "veryfast", "-x265-params", "log-level=error"],
  av1: ["-c:v", "libsvtav1", "-preset", "10"],
};

/** CPU decode + encode. Always available; also the fallback other strategies delegate to. */
export class SoftwareAccel implements HardwareAccel {
  readonly kind = "none";

  videoPipeline(request: VideoEncodeRequest): VideoPipeline {
    const { source, width, height } = request;
    const filters = source.width !== width || source.height !== height ? [`scale=${width}:${height}`] : [];
    return {
      inputArgs: [],
      // 8-bit 4:2:0 output: the widest-compatible choice, and it converts 10-bit sources.
      filters: [...filters, "format=yuv420p"],
      encoderArgs: [...ENCODER_ARGS[request.codec], ...rateControlArgs(request.bitrate)],
      decode: "software",
      encode: "software",
    };
  }
}
