const SEASON_EPISODE_PATTERN = /S(\d{1,3})E(\d{1,3})/i;
// Legacy "1x05" convention (predates SxxExx, still used by older libraries/tools e.g.
// Kodi/XBMC). Season/episode digit counts are deliberately asymmetric (1-2 vs 2-3) so this
// doesn't collide with resolution-like tokens such as "1920x1080" or aspect-ratio tags.
const LEGACY_X_SEPARATED_PATTERN = /\b(\d{1,2})x(\d{2,3})\b/i;
const QUALITY_MARKER_PATTERN =
  /\b(bluray|brrip|bdrip|web-?dl|webrip|hdtv|sdtv|dvdrip|480p|720p|1080p|2160p|4k|x264|x265|hevc)\b/i;
const BRACKETED_TAG_PATTERN = /\[[^[\]]*\]/g;
const DASH_NUMBERED_PATTERN = /-\s*(\d{1,3})\s*-\s*(.+)/;
const TRAILING_NUMBER_PATTERN = /\s(\d{1,3})\s*(?:\(|$)/g;

export interface ParsedEpisode {
  readonly season: number;
  readonly episode: number;
  readonly title: string;
}

function cleanTitleFragment(fragment: string, fallbackEpisode: number): string {
  const qualityIndex = QUALITY_MARKER_PATTERN.exec(fragment)?.index;
  const parenIndex = fragment.indexOf("(");
  const candidates = [qualityIndex, parenIndex >= 0 ? parenIndex : undefined].filter(
    (index): index is number => index !== undefined,
  );
  const cutIndex = candidates.length > 0 ? Math.min(...candidates) : undefined;
  const titlePart = cutIndex === undefined ? fragment : fragment.slice(0, cutIndex);

  const title = titlePart
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return title.length > 0 ? title : `Episode ${fallbackEpisode}`;
}

/** Shared by every "season+episode token followed by a title" convention (SxxExx, 1x05, ...). */
function matchSeasonEpisodeToken(fileNameWithoutExtension: string, pattern: RegExp): ParsedEpisode | null {
  const match = pattern.exec(fileNameWithoutExtension);
  if (!match || !match[1] || !match[2]) return null;

  const season = Number(match[1]);
  const episode = Number(match[2]);
  const afterToken = fileNameWithoutExtension.slice(match.index + match[0].length);

  return { season, episode, title: cleanTitleFragment(afterToken, episode) };
}

/**
 * Fansub/anime-scene releases often number episodes absolutely with no season token at
 * all — e.g. "[Group] Show Name - 08 - Episode Title (1080p) [hash].mkv" or
 * "[Group] Show Name 08 (1080p) [hash].mkv". Season is unknown in this convention, so it's
 * treated as season 1; this is a simplification for shows split across one folder per
 * season on disk, not a guarantee for every absolute-numbering release.
 */
function parseAbsoluteEpisode(withoutExtension: string): ParsedEpisode | null {
  const withoutBracketedTags = withoutExtension.replace(BRACKETED_TAG_PATTERN, " ").replace(/\s+/g, " ").trim();

  const dashMatch = DASH_NUMBERED_PATTERN.exec(withoutBracketedTags);
  if (dashMatch?.[1] && dashMatch[2] !== undefined) {
    const episode = Number(dashMatch[1]);
    return { season: 1, episode, title: cleanTitleFragment(dashMatch[2], episode) };
  }

  // No title segment to anchor on, so take the LAST standalone number before quality/
  // parenthetical info — closer to the episode token than any incidental digits earlier
  // in the title (e.g. a year or "Part 2").
  const trailingMatches = Array.from(withoutBracketedTags.matchAll(TRAILING_NUMBER_PATTERN));
  const lastMatch = trailingMatches.at(-1);
  if (lastMatch?.[1]) {
    const episode = Number(lastMatch[1]);
    return { season: 1, episode, title: `Episode ${episode}` };
  }

  return null;
}

/**
 * Pulls season/episode numbers and a best-effort episode title out of a release filename,
 * independent of whatever folder it happens to live in — real libraries have inconsistent/
 * duplicate/empty season folders, but the token in the filename itself is reliably present.
 * Tries, in order: the modern "SxxExx" convention, the legacy "1x05" convention, then
 * absolute/anime-style numbering. Multi-episode files (e.g. "S01E01E02") and date-based
 * daily-show episodes are not supported — both would need domain-model changes (a file
 * covering more than one Unit, or a non-numeric identity scheme) beyond parsing alone.
 */
export function parseEpisodeFilename(fileName: string): ParsedEpisode | null {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");

  return (
    matchSeasonEpisodeToken(withoutExtension, SEASON_EPISODE_PATTERN) ??
    matchSeasonEpisodeToken(withoutExtension, LEGACY_X_SEPARATED_PATTERN) ??
    parseAbsoluteEpisode(withoutExtension)
  );
}
