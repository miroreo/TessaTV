import ky, { type KyInstance } from "ky";
import { nullOn404, type QueryParams } from "./http.js";

const DEFAULT_BASE_URL = "https://api.themoviedb.org/3";
const DEFAULT_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";

export interface TmdbClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly imageBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Thin, injectable wrapper around TMDB's v3 REST API — the only place that knows TMDB's
 * wire format; everything above this talks in the generic MetadataProvider shapes. */
export class TmdbClient {
  private readonly apiKey: string;
  private readonly imageBaseUrl: string;
  private readonly http: KyInstance;

  constructor(options: TmdbClientOptions) {
    this.apiKey = options.apiKey;
    this.imageBaseUrl = options.imageBaseUrl ?? DEFAULT_IMAGE_BASE_URL;
    this.http = ky.create({
      prefix: options.baseUrl ?? DEFAULT_BASE_URL,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  }

  imageUrl(path: string | null | undefined): string | null {
    return path ? `${this.imageBaseUrl}${path}` : null;
  }

  get<T>(path: string, params: QueryParams = {}): Promise<T> {
    return this.http.get(path, { searchParams: { ...params, api_key: this.apiKey } }).json<T>();
  }

  /** Like `get`, but a 404 (unknown id) returns null instead of throwing. */
  getOrNull<T>(path: string, params: QueryParams = {}): Promise<T | null> {
    return nullOn404(this.get<T>(path, params));
  }
}
