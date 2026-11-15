import type { TranscodeVideoCodec } from "../client-capabilities.js";
import {
  rateControlArgs,
  SDR_COLOR_ARGS,
  supportsDecode,
  toneMapFilters,
  type HardwareAccel,
  type HardwareDecodeSupport,
  type VideoEncodeRequest,
  type VideoPipeline,
} from "./hardware-accel.js";

/** What this particular GPU/driver can do — detected at startup, not assumed per generation. */
export interface NvencCapabilities {
  /** CUDA device index, as `nvidia-smi` numbers GPUs. */
  readonly device: number;
  /** e.g. `NVIDIA GeForce RTX 3060`, when `nvidia-smi` says. */
  readonly deviceName?: string | null;
  readonly encode: readonly TranscodeVideoCodec[];
  readonly decode: readonly HardwareDecodeSupport[];
}

const ENCODERS: Record<TranscodeVideoCodec, readonly string[]> = {
  h264: ["-c:v", "h264_nvenc", "-profile:v", "high"],
  hevc: ["-c:v", "hevc_nvenc", "-profile:v", "main"],
  av1: ["-c:v", "av1_nvenc"],
};

/** How an NVIDIA GPU is named in the device list, next to VAAPI's `/dev/dri/renderD128`. */
export function nvencDeviceId(index: number): string {
  return `nvenc:${index}`;
}

/** The CUDA index in a device id from `nvencDeviceId`, or null for anything else (e.g. a render node). */
export function parseNvencDeviceId(id: string): number | null {
  const index = /^nvenc:(\d+)$/.exec(id)?.[1];
  return index === undefined ? null : Number(index);
}

export interface NvencOptions {
  /** Decode on the GPU (NVDEC) when it supports the source. On unless disabled. */
  readonly hardwareDecode?: boolean;
}

/**
 * NVENC encode, with NVDEC decode when enabled and the GPU supports the source codec + bit
 * depth. NVENC takes frames from system memory directly, so software-decoded and
 * software-filtered frames need no upload. Target codecs the GPU can't encode are delegated
 * to the fallback strategy wholesale.
 */
export class NvencAccel implements HardwareAccel {
  readonly kind = "nvenc";

  get device(): string {
    return nvencDeviceId(this.capabilities.device);
  }

  get deviceName(): string | null {
    return this.capabilities.deviceName ?? null;
  }

  constructor(
    readonly capabilities: NvencCapabilities,
    private readonly fallback: HardwareAccel,
    private readonly options: NvencOptions = {},
  ) {}

  canDecode(codec: string, bitDepth: number): boolean {
    return supportsDecode(this.capabilities.decode, codec, bitDepth);
  }

  videoPipeline(request: VideoEncodeRequest): VideoPipeline {
    if (!this.capabilities.encode.includes(request.codec)) return this.fallback.videoPipeline(request);

    const { source } = request;
    const hardwareDecode = this.options.hardwareDecode !== false && this.canDecode(source.codec, source.bitDepth);
    const { device } = this.capabilities;
    return {
      inputArgs: hardwareDecode
        ? [
            "-init_hw_device", `cuda=cu:${device}`,
            "-hwaccel", "cuda",
            "-hwaccel_device", "cu",
            "-hwaccel_output_format", "cuda",
          ]
        : [],
      ...this.filterChains(request, hardwareDecode),
      encoderArgs: [
        ...ENCODERS[request.codec],
        "-gpu", String(device),
        "-preset", "p4",
        "-rc", "vbr",
        ...rateControlArgs(request.bitrate),
        ...(source.isHdr ? SDR_COLOR_ARGS : []),
      ],
      decode: hardwareDecode ? "hardware" : "software",
      encode: "hardware",
    };
  }

  /**
   * Tone-mapping and subtitle overlay only run in software, so those frames visit system
   * memory. They're still decoded and scaled on the GPU where possible, so only frames
   * that are already at the target size get downloaded.
   */
  private filterChains(
    { source, width, height, burnIn }: VideoEncodeRequest,
    hardwareDecode: boolean,
  ): Pick<VideoPipeline, "filters" | "postOverlayFilters"> {
    const gpuScale = (format: string) => `scale_cuda=w=${width}:h=${height}:format=${format}`;
    if (source.isHdr) {
      return {
        filters: [
          ...(hardwareDecode ? [gpuScale("p010le"), "hwdownload", "format=p010le"] : []),
          ...toneMapFilters(width, height, "nv12"),
        ],
        postOverlayFilters: [],
      };
    }
    if (hardwareDecode) {
      return burnIn
        ? { filters: [gpuScale("nv12"), "hwdownload", "format=nv12"], postOverlayFilters: ["format=nv12"] }
        : { filters: [gpuScale("nv12")], postOverlayFilters: [] };
    }
    return {
      filters: [...(source.width !== width || source.height !== height ? [`scale=${width}:${height}`] : []), "format=nv12"],
      postOverlayFilters: burnIn ? ["format=nv12"] : [],
    };
  }
}
