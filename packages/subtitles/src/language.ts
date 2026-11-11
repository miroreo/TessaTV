import { iso6393 } from "iso-639-3";

const THREE_TO_TWO = new Map<string, string>();
for (const entry of iso6393) {
  if (entry.iso6391) THREE_TO_TWO.set(entry.iso6393, entry.iso6391);
}
const TWO_TO_THREE = new Map<string, string>();
for (const entry of iso6393) {
  if (entry.iso6391) TWO_TO_THREE.set(entry.iso6391, entry.iso6393);
}
const TWO_LETTER = new Set(THREE_TO_TWO.values());

/**
 * Providers disagree on language codes (`en`, `eng`, `pt-BR`, `pt_br`, `zh-TW`). This maps them
 * all to one form: a lowercase two-letter language, plus an uppercase region when given
 * (`en`, `pt-BR`). Returns null for anything that isn't a known language.
 */
export function normalizeLanguage(code: string): string | null {
  const [primary, region] = code.trim().replace(/_/g, "-").split("-");
  if (!primary) return null;
  const lower = primary.toLowerCase();
  const language = lower.length === 3 ? THREE_TO_TWO.get(lower) : TWO_LETTER.has(lower) ? lower : undefined;
  if (!language) return null;
  return region && /^[A-Za-z]{2}$/.test(region) ? `${language}-${region.toUpperCase()}` : language;
}

/** `pt-BR` → `pt`. */
export function primaryLanguage(code: string): string {
  return code.split("-")[0] ?? code;
}

/**
 * `en` / `pt-BR` → `eng` / `por`, the three-letter form media files tag their tracks with, so a
 * subtitle file and an embedded track in the same language compare equal. (A few languages have
 * two three-letter codes, and files use either; `fra` here may be `fre` in a file.)
 */
export function toThreeLetterLanguage(code: string): string | null {
  const normalized = normalizeLanguage(code);
  return normalized ? (TWO_TO_THREE.get(primaryLanguage(normalized)) ?? null) : null;
}
