import { filenameParse } from "@ctrl/video-filename-parser";

export interface ParsedEpisode {
  readonly season: number;
  readonly episode: number;
  readonly title: string;
}

/** The parser's remainder still carries leftover separators and quality fragments, e.g.
 * "The Second One -." or "The Big Fight (". */
function cleanRemainder(remainder: string | undefined): string {
  return (remainder ?? "")
    .replace(/[([].*$/, "")
    .replace(/[._]+/g, " ")
    .replace(/^[\s-]+|[\s.-]+$/g, "")
    .replace(/\s+/g, " ");
}

const QUALITY_TOKEN = /\b(\d{3,4}[pi]|web-?dl|web-?rip|hdtv|blu-?ray|bd-?rip|br-?rip|dvd-?rip|x26[45]|h\.?26[45]|hevc|xvid)\b/i;

/** The parser also reports leftovers from after the quality info (re-encode tags, "DD5 1")
 * as the remainder; a real episode title only ever sits before it. */
function remainderBeforeQuality(name: string, remainder: string | undefined): string | undefined {
  if (!remainder) return remainder;
  const spaced = name.replace(/[._]+/g, " ");
  const quality = spaced.search(QUALITY_TOKEN);
  const at = spaced.toLowerCase().indexOf(remainder.toLowerCase());
  return quality !== -1 && at >= quality ? undefined : remainder;
}

/**
 * Season/episode numbers and a best-effort episode title from a release filename, via
 * @ctrl/video-filename-parser (a port of Sonarr's parser): SxxExx, 1x05, absolute/anime
 * numbering and more. Absolute numbering has no season, so it's treated as season 1. A
 * multi-episode file ("S01E01E02") is read as its first episode, since the domain model
 * maps one file to one Unit.
 */
export function parseEpisodeFilename(fileName: string): ParsedEpisode | null {
  const name = fileName.replace(/\.[^.]+$/, "");
  const parsed = filenameParse(name, true);
  if (!("episodeNumbers" in parsed)) return null;
  const episode = parsed.episodeNumbers[0];
  if (episode === undefined) return null;
  const title = cleanRemainder(remainderBeforeQuality(name, parsed.remainder));
  return { season: parsed.seasons[0] ?? 1, episode, title: title || `Episode ${episode}` };
}
