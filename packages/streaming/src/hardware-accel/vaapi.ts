import type { TranscodeVideoCodec } from "../client-capabilities.js";
import { rateControlArgs, SDR_COLOR_ARGS, toneMapFilters, type HardwareAccel, type VideoEncodeRequest, type VideoPipeline } from "./hardware-accel.js";

export interface VaapiDecodeSupport {
  readonly codec: string;
  readonly bitDepth: number;
}

/** What this particular GPU/driver can do — detected at startup, not assumed per vendor. */
export interface VaapiCapabilities {
  /** DRM render node, e.g. `/dev/dri/renderD128`. */
  readonly device: string;
  /** What the driver calls the GPU (e.g. `AMD Radeon 780M Graphics`), when it says. */
  readonly deviceName?: string | null;
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

  get deviceName(): string | null {
    return this.capabilities.deviceName ?? null;
  }

  constructor(
    readonly capabilities: VaapiCapabilities,
    private readonly fallback: HardwareAccel,
  ) {}

  canDecode(codec: string, bitDepth: number): boolean {
    return this.capabilities.decode.some((entry) => entry.codec === codec && entry.bitDepth === bitDepth);
  }

  videoPipeline(request: VideoEncodeRequest): VideoPipeline {
    if (!this.capabilities.encode.includes(request.codec)) return this.fallback.videoPipeline(request);

    const { source } = request;
    const hardwareDecode = this.canDecode(source.codec, source.bitDepth);
    return {
      inputArgs: [
        "-init_hw_device",
        `vaapi=va:${this.capabilities.device}`,
        "-filter_hw_device",
        "va",
        ...(hardwareDecode ? ["-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi"] : []),
      ],
      ...this.filterChains(request, hardwareDecode),
      encoderArgs: [
        ...ENCODERS[request.codec],
        "-rc_mode",
        "VBR",
        ...rateControlArgs(request.bitrate),
        ...(source.isHdr ? SDR_COLOR_ARGS : []),
      ],
      decode: hardwareDecode ? "hardware" : "software",
      encode: "hardware",
    };
  }

  /**
   * Tone-mapping and subtitle overlay only run in software, so those frames visit system
   * memory. They're still decoded and scaled on the GPU where possible: downloading frames
   * that are already 1080p is what makes 4K HDR sources keep up with realtime.
   */
  private filterChains(
    { source, width, height, burnIn }: VideoEncodeRequest,
    hardwareDecode: boolean,
  ): Pick<VideoPipeline, "filters" | "postOverlayFilters"> {
    const gpuScale = (format: string) => `scale_vaapi=w=${width}:h=${height}:format=${format}`;
    if (source.isHdr) {
      return {
        filters: [
          ...(hardwareDecode ? [gpuScale("p010"), "hwdownload", "format=p010le"] : []),
          ...toneMapFilters(width, height, "nv12"),
        ],
        postOverlayFilters: ["hwupload"],
      };
    }
    if (burnIn) {
      return {
        filters: hardwareDecode
          ? [gpuScale("nv12"), "hwdownload", "format=nv12"]
          : [`scale=${width}:${height}`, "format=nv12"],
        postOverlayFilters: ["format=nv12", "hwupload"],
      };
    }
    return {
      filters: hardwareDecode ? [gpuScale("nv12")] : ["format=nv12", "hwupload", gpuScale("nv12")],
      postOverlayFilters: [],
    };
  }
}
