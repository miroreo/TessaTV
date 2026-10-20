import type { TranscodeVideoCodec } from "../client-capabilities.js";
import { rateControlArgs, type HardwareAccel, type VideoEncodeRequest, type VideoPipeline } from "./hardware-accel.js";

export interface VaapiDecodeSupport {
  readonly codec: string;
  readonly bitDepth: number;
}

/** What this particular GPU/driver can do — detected at startup, not assumed per vendor. */
export interface VaapiCapabilities {
  /** DRM render node, e.g. `/dev/dri/renderD128`. */
  readonly device: string;
  readonly encode: readonly TranscodeVideoCodec[];
  readonly decode: readonly VaapiDecodeSupport[];
}

const ENCODERS: Record<TranscodeVideoCodec, readonly string[]> = {
  h264: ["-c:v", "h264_vaapi", "-profile:v", "high"],
  hevc: ["-c:v", "hevc_vaapi", "-profile:v", "main"],
  av1: ["-c:v", "av1_vaapi"],
};

/**
 * VAAPI encode, with hardware decode when the GPU supports the source codec + bit depth and
 * software decode + `hwupload` otherwise (e.g. XviD on most GPUs). Target codecs the GPU
 * can't encode are delegated to the fallback strategy wholesale.
 */
export class VaapiAccel implements HardwareAccel {
  readonly kind = "vaapi";

  constructor(
    readonly capabilities: VaapiCapabilities,
    private readonly fallback: HardwareAccel,
  ) {}

  canDecode(codec: string, bitDepth: number): boolean {
    return this.capabilities.decode.some((entry) => entry.codec === codec && entry.bitDepth === bitDepth);
  }

  videoPipeline(request: VideoEncodeRequest): VideoPipeline {
    if (!this.capabilities.encode.includes(request.codec)) return this.fallback.videoPipeline(request);

    const hardwareDecode = this.canDecode(request.source.codec, request.source.bitDepth);
    const scale = `scale_vaapi=w=${request.width}:h=${request.height}:format=nv12`;
    return {
      inputArgs: [
        "-init_hw_device",
        `vaapi=va:${this.capabilities.device}`,
        "-filter_hw_device",
        "va",
        ...(hardwareDecode ? ["-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi"] : []),
      ],
      filters: hardwareDecode ? [scale] : ["format=nv12", "hwupload", scale],
      encoderArgs: [...ENCODERS[request.codec], "-rc_mode", "VBR", ...rateControlArgs(request.bitrate)],
      decode: hardwareDecode ? "hardware" : "software",
      encode: "hardware",
    };
  }
}
