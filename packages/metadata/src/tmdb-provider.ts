import type {
  MetadataDetails,
  MetadataMediaKind,
  MetadataProvider,
  MetadataSearchCandidate,
  MetadataSearchQuery,
} from "./metadata-provider.js";
import { TmdbClient } from "./tmdb-client.js";

interface TmdbSearchResultMovie {
  readonly id: number;
  readonly title: string;
  readonly release_date?: string;
  readonly overview?: string;
  readonly poster_path?: string | null;
}

interface TmdbSearchResultTv {
  readonly id: number;
  readonly name: string;
  readonly first_air_date?: string;
  readonly overview?: string;
  readonly poster_path?: string | null;
}

interface TmdbSearchResponse<T> {
  readonly results: readonly T[];
}

interface TmdbMovieDetails {
  readonly id: number;
  readonly title: string;
  readonly overview?: string;
  readonly release_date?: string;
  readonly poster_path?: string | null;
  readonly backdrop_path?: string | null;
}

interface TmdbTvDetails {
  readonly id: number;
  readonly name: string;
  readonly overview?: string;
  readonly first_air_date?: string;
  readonly poster_path?: string | null;
  readonly backdrop_path?: string | null;
}

function yearFromDate(date: string | undefined): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

export class TmdbMetadataProvider implements MetadataProvider {
  readonly id = "tmdb";

  constructor(private readonly client: TmdbClient) {}

  async search(query: MetadataSearchQuery): Promise<MetadataSearchCandidate[]> {
    if (query.mediaKind === "movie") {
      const response = await this.client.get<TmdbSearchResponse<TmdbSearchResultMovie>>("/search/movie", {
        query: query.title,
        year: query.year ?? undefined,
      });
      return response.results.map((result) => ({
        externalId: String(result.id),
        title: result.title,
        year: yearFromDate(result.release_date),
        overview: result.overview ?? null,
        posterUrl: this.client.imageUrl(result.poster_path),
      }));
    }

    const response = await this.client.get<TmdbSearchResponse<TmdbSearchResultTv>>("/search/tv", {
      query: query.title,
      first_air_date_year: query.year ?? undefined,
    });
    return response.results.map((result) => ({
      externalId: String(result.id),
      title: result.name,
      year: yearFromDate(result.first_air_date),
      overview: result.overview ?? null,
      posterUrl: this.client.imageUrl(result.poster_path),
    }));
  }

  async fetchDetails(externalId: string, mediaKind: MetadataMediaKind): Promise<MetadataDetails | null> {
    if (mediaKind === "movie") {
      const details = await this.client.getOrNull<TmdbMovieDetails>(`/movie/${externalId}`);
      if (!details) return null;
      return {
        externalId: String(details.id),
        title: details.title,
        overview: details.overview ?? null,
        year: yearFromDate(details.release_date),
        posterUrl: this.client.imageUrl(details.poster_path),
        backdropUrl: this.client.imageUrl(details.backdrop_path),
      };
    }

    const details = await this.client.getOrNull<TmdbTvDetails>(`/tv/${externalId}`);
    if (!details) return null;
    return {
      externalId: String(details.id),
      title: details.name,
      overview: details.overview ?? null,
      year: yearFromDate(details.first_air_date),
      posterUrl: this.client.imageUrl(details.poster_path),
      backdropUrl: this.client.imageUrl(details.backdrop_path),
    };
  }
}
