import type { StreamOption } from "@tessatv/domain";

/**
 * Per-browser playback preferences. Remembered so a choice made once carries over to the
 * next episode and the next visit, instead of resetting every time the player opens.
 * Storage can be unavailable (private mode); then choices just don't persist.
 */
const KEYS = {
  maxBitrate: "tessatv.maxBitrate",
  audioLanguage: "tessatv.audioLanguage",
  subtitleLanguage: "tessatv.subtitleLanguage",
  volume: "tessatv.volume",
} as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not persisted; the choice still applies to this playback.
  }
}

/** Quality cap in bits/second; null means "original" (no cap). */
export function getMaxBitrate(): number | null {
  const stored = Number(read(KEYS.maxBitrate));
  return stored > 0 ? stored : null;
}

export function setMaxBitrate(value: number | null): void {
  write(KEYS.maxBitrate, value ? String(value) : null);
}

/** 0–1; a negative number stands for "muted at that volume". */
export function getVolume(): { volume: number; muted: boolean } {
  const stored = Number(read(KEYS.volume) ?? 1);
  if (!Number.isFinite(stored)) return { volume: 1, muted: false };
  return { volume: Math.min(1, Math.abs(stored)), muted: stored < 0 || Object.is(stored, -0) };
}

export function setVolume(volume: number, muted: boolean): void {
  write(KEYS.volume, String(muted ? -Math.max(volume, 0.01) : volume));
}

/** Tracks without a language tag are remembered as "und", ISO 639's "undetermined". */
const languageOf = (stream: StreamOption) => stream.language ?? "und";

export function rememberAudio(stream: StreamOption | undefined): void {
  if (stream) write(KEYS.audioLanguage, languageOf(stream));
}

export function rememberSubtitles(stream: StreamOption | undefined): void {
  write(KEYS.subtitleLanguage, stream ? languageOf(stream) : "off");
}

export function pickAudio(streams: readonly StreamOption[]): StreamOption | undefined {
  const language = read(KEYS.audioLanguage);
  return (
    streams.find((stream) => language !== null && languageOf(stream) === language) ??
    streams.find((stream) => stream.isDefault) ??
    streams[0]
  );
}

/**
 * The remembered subtitle language if this file has it (a full track over a forced-only
 * one, text over burned-in), "off" if that was the last choice, and otherwise only a
 * forced track — the file's way of saying "subtitle the foreign-language bits".
 */
export function pickSubtitles(streams: readonly StreamOption[]): StreamOption | undefined {
  const language = read(KEYS.subtitleLanguage);
  if (language === "off") return undefined;
  if (language !== null) {
    const matching = streams
      .filter((stream) => languageOf(stream) === language)
      .sort((a, b) => Number(a.isForced ?? false) - Number(b.isForced ?? false) || Number(b.isTextBased ?? true) - Number(a.isTextBased ?? true));
    if (matching[0]) return matching[0];
  }
  return streams.find((stream) => stream.isForced);
}
