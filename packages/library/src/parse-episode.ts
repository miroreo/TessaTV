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

/**
 * Season/episode numbers and a best-effort episode title from a release filename, via
 * @ctrl/video-filename-parser (a port of Sonarr's parser): SxxExx, 1x05, absolute/anime
 * numbering and more. Absolute numbering has no season, so it's treated as season 1. A
 * multi-episode file ("S01E01E02") is read as its first episode, since the domain model
 * maps one file to one Unit.
 */
export function parseEpisodeFilename(fileName: string): ParsedEpisode | null {
  const parsed = filenameParse(fileName.replace(/\.[^.]+$/, ""), true);
  if (!("episodeNumbers" in parsed)) return null;
  const episode = parsed.episodeNumbers[0];
  if (episode === undefined) return null;
  const title = cleanRemainder(parsed.remainder);
  return { season: parsed.seasons[0] ?? 1, episode, title: title || `Episode ${episode}` };
}
