import type { SubtitlePreference } from "./score.js";
import { normalizeLanguage } from "./language.js";

/**
 * Reads a setting like `en,pt-BR,en.forced` into the slots to fill, in that order. Each entry is
 * a language, optionally followed by `.forced` for that language's forced track. Entries that
 * aren't a language, and repeats, come back in `invalid` rather than being silently dropped.
 */
export function parseSubtitlePreferences(
  value: string,
  hearingImpaired: SubtitlePreference["hearingImpaired"],
): { preferences: SubtitlePreference[]; invalid: string[] } {
  const preferences: SubtitlePreference[] = [];
  const invalid: string[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const [code, flag, ...extra] = entry.split(".");
    const language = normalizeLanguage(code ?? "");
    const forced = flag?.toLowerCase() === "forced";
    const duplicate = preferences.some((p) => p.language === language && p.forced === forced);
    if (!language || extra.length > 0 || (flag !== undefined && !forced) || duplicate) invalid.push(entry);
    else preferences.push({ language, forced, hearingImpaired });
  }
  return { preferences, invalid };
}
