/** HLS segment formats. MPEG-TS is the most compatible; fMP4 is required for HEVC/AV1 on Apple. */
export type HlsSegmentContainer = "mpegts" | "fmp4";

/** Video codecs TessaTV knows how to produce when transcoding. */
export type TranscodeVideoCodec = "h264" | "hevc" | "av1";

export type TranscodeAudioCodec = "aac" | "mp3" | "ac3" | "eac3" | "opus" | "flac";

export interface VideoCodecSupport {
  /** ffmpeg codec name (`h264`, `hevc`, `av1`, `vp9`, ...). */
  readonly codec: string;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxBitDepth?: number;
  /** ffprobe profile names (e.g. `High`, `Main 10`). Omitted means any profile. */
  readonly profiles?: readonly string[];
}

export interface AudioCodecSupport {
  readonly codec: string;
  readonly maxChannels?: number;
}

/**
 * What a client can play, in TessaTV's own terms. Deliberately not Jellyfin's
 * `DeviceProfile` — `jellyfin-compat` translates into this at its boundary.
 */
export interface ClientCapabilities {
  /** Containers the client can play as a progressive (direct-play) file. */
  readonly directPlayContainers: readonly string[];
  /** Video the client can decode, whether delivered direct or inside HLS. */
  readonly videoCodecs: readonly VideoCodecSupport[];
  readonly audioCodecs: readonly AudioCodecSupport[];
  /** Upper bound for the whole stream, in bits/second. */
  readonly maxBitrate?: number;
  readonly hls: {
    /** In order of preference. */
    readonly segmentContainers: readonly HlsSegmentContainer[];
    /** Codecs to transcode video into, in order of preference. */
    readonly videoCodecs: readonly TranscodeVideoCodec[];
    /** Codecs to transcode audio into, in order of preference. */
    readonly audioCodecs: readonly TranscodeAudioCodec[];
    readonly maxAudioChannels?: number;
  };
}
