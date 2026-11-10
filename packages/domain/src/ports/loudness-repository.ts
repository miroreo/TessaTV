import type { LoudnessMeasurement } from "../loudness.js";

export interface LoudnessRepository {
  get(mediaFileId: string): Promise<LoudnessMeasurement | null>;
  /** Inserts or replaces the file's measurement. */
  save(measurement: LoudnessMeasurement): Promise<void>;
  /** Files never measured (successfully or not), most recently imported first. */
  listUnmeasured(limit: number): Promise<{ id: string; path: string }[]>;
}
