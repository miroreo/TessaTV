/**
 * Integrated loudness (EBU R128 / ITU-R BS.1770) of one audio stream, measured once per
 * media file so playback can level it without re-encoding — the ReplayGain model.
 */
export interface LoudnessMeasurement {
  readonly mediaFileId: string;
  /** Absolute ffprobe index of the audio stream that was measured. */
  readonly streamIndex: number;
  /** Null when there was nothing measurable (no audio, silence) or measuring failed. */
  readonly integratedLufs: number | null;
  readonly truePeakDbtp: number | null;
  readonly measuredAt: Date;
  /** Why measuring failed, so a broken file isn't retried on every scan. */
  readonly error: string | null;
}

/** EBU R128's broadcast target: TV and film are mastered close to it, so most files barely move. */
export const TARGET_LOUDNESS_LUFS = -23;
/** Never move a file more than this — a near-silent track shouldn't be pumped up absurdly. */
export const MAX_NORMALIZATION_DB = 12;
/** BS.1770's absolute gate: anything quieter is effectively silence, not quiet content. */
const SILENCE_LUFS = -70;

/** The gain, in dB, that brings a stream measured at `integratedLufs` to the target. */
export function normalizationGainDb(integratedLufs: number): number {
  if (integratedLufs <= SILENCE_LUFS) return 0;
  const gain = TARGET_LOUDNESS_LUFS - integratedLufs;
  return Math.round(Math.max(-MAX_NORMALIZATION_DB, Math.min(MAX_NORMALIZATION_DB, gain)) * 10) / 10;
}
