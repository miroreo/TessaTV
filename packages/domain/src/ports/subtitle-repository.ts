import type { SubtitleFile, SubtitleSearchRecord, SubtitleSlot, WantedSubtitle } from "../subtitle.js";

export interface SubtitleRepository {
  /** Every subtitle file recorded, for checking them against what is on disk. */
  listAll(): Promise<SubtitleFile[]>;
  /** Every unit with a playable file, for finding subtitle files beside them. */
  listPlayableFiles(): Promise<WantedSubtitle[]>;
  listForUnit(unitId: string): Promise<SubtitleFile[]>;
  get(id: string): Promise<SubtitleFile | null>;
  /** Also clears the slot's search record, since it is filled now. */
  add(file: SubtitleFile): Promise<void>;
  remove(id: string): Promise<void>;

  /**
   * Units with a playable file, and no subtitle for `slot`, whose slot isn't waiting on a
   * `retryAfter` in the future. Newest imports first.
   */
  listWanting(slot: SubtitleSlot, now: Date, limit: number): Promise<WantedSubtitle[]>;
  getSearchRecord(unitId: string, slotKey: string): Promise<SubtitleSearchRecord | null>;
  saveSearchRecord(record: SubtitleSearchRecord): Promise<void>;

  /** Candidates a person rejected (or that proved unusable) for a unit, never offered again. */
  listBlacklisted(unitId: string): Promise<{ provider: string; providerId: string }[]>;
  blacklist(unitId: string, provider: string, providerId: string): Promise<void>;
}
