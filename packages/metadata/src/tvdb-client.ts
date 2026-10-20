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
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | null = null;

  constructor(options: TvdbClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async login(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: this.apiKey }),
    });
    if (!response.ok) {
      throw new Error(`TheTVDB login failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as TvdbEnvelope<{ token: string }>;
    this.token = body.data.token;
    return this.token;
  }

  async get<T>(path: string, params: Record<string, string | undefined> = {}, isRetry = false): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const token = this.token ?? (await this.login());
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });

    if (response.status === 401 && !isRetry) {
      this.token = null;
      return this.get<T>(path, params, true);
    }
    if (!response.ok) {
      throw new Error(`TheTVDB request failed: ${response.status} ${response.statusText} (${url.pathname})`);
    }
    const body = (await response.json()) as TvdbEnvelope<T>;
    return body.data;
  }

  /** Like `get`, but a 404 (unknown id) returns null instead of throwing. */
  async getOrNull<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, params);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) return null;
      throw error;
    }
  }
}
