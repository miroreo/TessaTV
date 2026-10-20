import type {
  MetadataDetails,
  MetadataMediaKind,
  MetadataProvider,
  MetadataSearchCandidate,
  MetadataSearchQuery,
} from "./metadata-provider.js";
import { TvdbClient } from "./tvdb-client.js";

interface TvdbSearchResult {
  readonly tvdb_id: string;
  readonly name: string;
  readonly year?: string;
  readonly overview?: string;
  readonly image_url?: string;
}

interface TvdbArtwork {
  readonly type: number;
  readonly image: string;
}

interface TvdbMovieExtended {
  readonly id: number;
  readonly name: string;
  readonly year?: string;
  readonly image?: string;
  readonly artworks?: readonly TvdbArtwork[];
}

interface TvdbSeriesExtended {
  readonly id: number;
  readonly name: string;
  readonly year?: string;
  readonly overview?: string;
  readonly image?: string;
  readonly artworks?: readonly TvdbArtwork[];
}

interface TvdbTranslation {
  readonly overview?: string;
}

// Confirmed against TheTVDB's own `/artwork/types` reference endpoint — these ids are
// NOT shared between record types (series posters are type 2, movie posters are type 14).
const MOVIE_BACKGROUND_TYPE = 15;
const SERIES_BACKGROUND_TYPE = 3;

function findArtwork(artworks: readonly TvdbArtwork[] | undefined, type: number): string | null {
  return artworks?.find((artwork) => artwork.type === type)?.image ?? null;
}

function parseYear(year: string | undefined): number | null {
  const parsed = Number(year);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class TvdbMetadataProvider implements MetadataProvider {
  readonly id = "tvdb";

  constructor(private readonly client: TvdbClient) {}

  async search(query: MetadataSearchQuery): Promise<MetadataSearchCandidate[]> {
    const results = await this.client.get<TvdbSearchResult[]>("/search", {
      query: query.title,
      type: query.mediaKind,
      year: query.year ? String(query.year) : undefined,
    });

    return results.map((result) => ({
      externalId: result.tvdb_id,
      title: result.name,
      year: parseYear(result.year),
      overview: result.overview ?? null,
      posterUrl: result.image_url ?? null,
    }));
  }

  async fetchDetails(externalId: string, mediaKind: MetadataMediaKind): Promise<MetadataDetails | null> {
    if (mediaKind === "movie") {
      const details = await this.client.getOrNull<TvdbMovieExtended>(`/movies/${externalId}/extended`);
      if (!details) return null;

      // `extended` lists which languages a translation exists in, not the text itself —
      // confirmed live: a separate call is required to get the actual overview.
      const translation = await this.client.getOrNull<TvdbTranslation>(`/movies/${externalId}/translations/eng`);

      return {
        externalId: String(details.id),
        title: details.name,
        overview: translation?.overview ?? null,
        year: parseYear(details.year),
        posterUrl: details.image ?? null,
        backdropUrl: findArtwork(details.artworks, MOVIE_BACKGROUND_TYPE),
      };
    }

    const details = await this.client.getOrNull<TvdbSeriesExtended>(`/series/${externalId}/extended`);
    if (!details) return null;

    return {
      externalId: String(details.id),
      title: details.name,
      overview: details.overview ?? null,
      year: parseYear(details.year),
      posterUrl: details.image ?? null,
      backdropUrl: findArtwork(details.artworks, SERIES_BACKGROUND_TYPE),
    };
  }
}
