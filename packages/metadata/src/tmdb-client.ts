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
  private readonly baseUrl: string;
  private readonly imageBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TmdbClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.imageBaseUrl = options.imageBaseUrl ?? DEFAULT_IMAGE_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  imageUrl(path: string | null | undefined): string | null {
    return path ? `${this.imageBaseUrl}${path}` : null;
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("api_key", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`TMDB request failed: ${response.status} ${response.statusText} (${url.pathname})`);
    }
    return (await response.json()) as T;
  }

  /** Like `get`, but a 404 (unknown id) returns null instead of throwing. */
  async getOrNull<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, params);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) return null;
      throw error;
    }
  }
}
