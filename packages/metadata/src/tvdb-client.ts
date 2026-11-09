import ky, { type KyInstance } from "ky";
import { nullOn404, type QueryParams } from "./http.js";

const DEFAULT_BASE_URL = "https://api4.thetvdb.com/v4";

export interface TvdbClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface TvdbEnvelope<T> {
  readonly status: string;
  readonly data: T;
}

/**
 * Thin, injectable wrapper around TheTVDB's v4 REST API. Unlike TMDB's simple api_key
 * query param, this needs a login step first: POST /login with the api key returns a
 * bearer token (confirmed live: valid for about a month). The token is cached in memory
 * and refreshed reactively — a 401 triggers exactly one re-login-and-retry, rather than
 * proactively tracking the token's expiry.
 */
export class TvdbClient {
  private readonly apiKey: string;
  private readonly http: KyInstance;
  private token: string | null = null;

  constructor(options: TvdbClientOptions) {
    this.apiKey = options.apiKey;
    this.http = ky.create({
      prefix: options.baseUrl ?? DEFAULT_BASE_URL,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
      hooks: {
        beforeRequest: [
          async ({ request }) => {
            if (new URL(request.url).pathname.endsWith("/login")) return;
            request.headers.set("Authorization", `Bearer ${this.token ?? (await this.login())}`);
          },
        ],
        afterResponse: [
          async ({ request, response, retryCount }) => {
            if (response.status !== 401 || retryCount > 0 || new URL(request.url).pathname.endsWith("/login")) return;
            this.token = null;
            const headers = new Headers(request.headers);
            headers.set("Authorization", `Bearer ${await this.login()}`);
            return ky.retry({ request: new Request(request, { headers }) });
          },
        ],
      },
    });
  }

  private async login(): Promise<string> {
    const body = await this.http.post("login", { json: { apikey: this.apiKey } }).json<TvdbEnvelope<{ token: string }>>();
    this.token = body.data.token;
    return this.token;
  }

  async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const body = await this.http.get(path, { searchParams: params }).json<TvdbEnvelope<T>>();
    return body.data;
  }

  /** Like `get`, but a 404 (unknown id) returns null instead of throwing. */
  getOrNull<T>(path: string, params: QueryParams = {}): Promise<T | null> {
    return nullOn404(this.get<T>(path, params));
  }
}
