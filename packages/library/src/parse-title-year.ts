// Provider-id tags appended per Jellyfin/Radarr's documented naming convention, e.g.
// "Movie Title (1999) {tmdb-603}" or "Movie Title (1999) [imdbid-tt0137523]". One or more
// may be chained; strip them before looking for the year so their brackets don't interfere.
const TRAILING_PROVIDER_TAG_PATTERN = /(?:\s*[{[]\w+-[^\]}]+[\]}])+$/i;
const TRAILING_YEAR_PATTERN = /^(.+?)\s*\((\d{4})\)$/;

export interface TitleAndYear {
  readonly title: string;
  readonly year: number | null;
}

/** Parses the Sonarr/Radarr-style folder convention "Title (Year)", e.g. "Some Movie (1999)". */
export function parseTitleAndYear(folderName: string): TitleAndYear {
  const withoutProviderTags = folderName.replace(TRAILING_PROVIDER_TAG_PATTERN, "").trim();
  const match = TRAILING_YEAR_PATTERN.exec(withoutProviderTags);
  if (!match) {
    return { title: withoutProviderTags, year: null };
  }
  const [, title, year] = match;
  return { title: (title ?? withoutProviderTags).trim(), year: Number(year) };
}

/** Normalizes a show folder name like "Some.Show.Name" into "Some Show Name". */
export function normalizeSeriesTitle(folderName: string): string {
  const { title } = parseTitleAndYear(folderName);
  return title.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}
