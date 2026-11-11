export interface FfmpegProgress {
  /** Position in the output, in seconds. */
  readonly outTimeSeconds: number;
  /** Speed relative to realtime (2 = twice as fast as playback). */
  readonly speed: number | null;
  /** Frames per second ffmpeg is processing; null for audio-only work or before the first frame. */
  readonly fps: number | null;
}

/**
 * Parses ffmpeg's `-progress pipe:1` output: `key=value` lines in blocks, each ended by a
 * `progress=` line. Feed it stdout chunks as they arrive (a line may be split across two);
 * it calls `onProgress` once per finished block. A key missing from a block (ffmpeg prints
 * `N/A` early on) keeps its previous value.
 */
export class FfmpegProgressParser {
  private buffer = "";
  private pending: { outTimeSeconds?: number; speed?: number | null; fps?: number | null } = {};
  private latest: FfmpegProgress = { outTimeSeconds: 0, speed: null, fps: null };

  constructor(private readonly onProgress: (progress: FfmpegProgress) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === "out_time_us" || key === "out_time_ms") {
        // Both keys are microseconds (`out_time_ms` is a long-standing ffmpeg misnomer).
        const micros = Number(value);
        if (Number.isFinite(micros)) this.pending.outTimeSeconds = micros / 1_000_000;
      } else if (key === "speed") {
        const speed = Number.parseFloat(value);
        this.pending.speed = Number.isFinite(speed) ? speed : null;
      } else if (key === "fps") {
        const fps = Number.parseFloat(value);
        this.pending.fps = Number.isFinite(fps) ? fps : null;
      } else if (key === "progress") {
        this.latest = {
          outTimeSeconds: this.pending.outTimeSeconds ?? this.latest.outTimeSeconds,
          speed: this.pending.speed !== undefined ? this.pending.speed : this.latest.speed,
          fps: this.pending.fps !== undefined ? this.pending.fps : this.latest.fps,
        };
        this.pending = {};
        this.onProgress(this.latest);
      }
    }
  }
}
