import ky, { isHTTPError, type KyInstance } from "ky";
import { AuthFailedError, QuotaExhaustedError, RateLimitedError, SubtitleProviderError } from "./errors.js";
import { normalizeLanguage } from "./language.js";
import type {
  SubtitleCandidate,
  SubtitleDownload,
  SubtitleFormat,
  SubtitleProvider,
  SubtitleQuery,
} from "./subtitle-provider.js";

// Endpoints and field names are from OpenSubtitles.com's REST API v1 as remembered, and were
// not checked against the live docs when written: verify against https://opensubtitles.stoplight.io
// before relying on them.

const PROVIDER = "opensubtitles";
const DEFAULT_BASE_URL = "https://api.opensubtitles.com/api/v1";

export interface OpenSubtitlesOptions {
  /** The API consumer key from the owner's own opensubtitles.com account. */
  readonly apiKey: string;
  /** The account's login, needed to download (searching works without). */
  readonly username: string;
  readonly password: string;
  /** Sent as `User-Agent`; OpenSubtitles requires one that names the app. */
  readonly userAgent: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface SearchResponse {
  readonly data: readonly {
    readonly id: string;
    readonly attributes: {
      readonly language: string;
      readonly download_count?: number;
      readonly hearing_impaired?: boolean;
      readonly foreign_parts_only?: boolean;
      readonly machine_translated?: boolean;
      readonly ai_translated?: boolean;
      readonly moviehash_match?: boolean;
      readonly release?: string;
      readonly upload_date?: string;
      readonly feature_details?: { readonly season_number?: number; readonly episode_number?: number };
      readonly files: readonly { readonly file_id: number; readonly file_name?: string }[];
    };
  }[];
}

interface DownloadResponse {
  readonly link: string;
  readonly file_name?: string;
  readonly reset_time_utc?: string;
}

function extensionOf(fileName: string | undefined): SubtitleFormat {
  const ext = fileName?.split(".").pop()?.toLowerCase();
  return ext === "ass" || ext === "ssa" || ext === "vtt" || ext === "sub" ? ext : "srt";
}

function stripImdbPrefix(id: string): string {
  return id.replace(/^tt/i, "");
}

export class OpenSubtitlesProvider implements SubtitleProvider {
  readonly id = PROVIDER;
  readonly capabilities = { hashSearch: true };

  private readonly http: KyInstance;
  private token: string | null = null;

  constructor(private readonly options: OpenSubtitlesOptions) {
    this.http = ky.create({
      prefix: options.baseUrl ?? DEFAULT_BASE_URL,
      headers: { "Api-Key": options.apiKey, "User-Agent": options.userAgent, Accept: "application/json" },
      retry: 0,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const ids = query.externalIds;
    const params: Record<string, string | number> = {
      languages: [...query.languages].map((language) => language.toLowerCase()).sort().join(","),
      // Machine-translated files are excluded at the source unless the owner opted in.
      ai_translated: query.allowMachineTranslated ? "include" : "exclude",
      machine_translated: query.allowMachineTranslated ? "include" : "exclude",
      foreign_parts_only: query.forced ? "only" : "exclude",
      hearing_impaired: "include",
    };
    if (query.movieHash) params.moviehash = query.movieHash;
    if (query.kind === "episode") {
      // Episodes are searched by the series' id plus season and episode numbers.
      if (ids.tmdb) params.parent_tmdb_id = ids.tmdb;
      if (ids.imdb) params.parent_imdb_id = stripImdbPrefix(ids.imdb);
      if (query.season !== undefined) params.season_number = query.season;
      if (query.episode !== undefined) params.episode_number = query.episode;
    } else {
      if (ids.tmdb) params.tmdb_id = ids.tmdb;
      if (ids.imdb) params.imdb_id = stripImdbPrefix(ids.imdb);
    }
    if (!params.moviehash && !params.tmdb_id && !params.imdb_id && !params.parent_tmdb_id && !params.parent_imdb_id) {
      params.query = query.title;
      if (query.year !== null && query.kind === "movie") params.year = query.year;
    }

    // The API wants lowercase, alphabetically ordered parameters (otherwise it redirects).
    const searchParams = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
    const response = await this.request(() => this.http.get("subtitles", { searchParams }).json<SearchResponse>());

    const byId = ids.tmdb ? "tmdb" : ids.imdb ? "imdb" : "title";
    return response.data.flatMap((entry) => {
      const { attributes } = entry;
      const language = normalizeLanguage(attributes.language);
      const file = attributes.files[0];
      if (!language || !file) return [];
      return [
        {
          provider: PROVIDER,
          providerId: String(file.file_id),
          language,
          format: extensionOf(file.file_name),
          forced: attributes.foreign_parts_only ?? false,
          hearingImpaired: attributes.hearing_impaired ?? false,
          aiTranslated: attributes.ai_translated ?? false,
          machineTranslated: attributes.machine_translated ?? false,
          releaseName: attributes.release ?? file.file_name ?? null,
          matchedBy: attributes.moviehash_match ? (["hash"] as const) : ([byId] as const),
          season: attributes.feature_details?.season_number ?? null,
          episode: attributes.feature_details?.episode_number ?? null,
          downloadCount: attributes.download_count ?? null,
          uploadedAt: attributes.upload_date ? new Date(attributes.upload_date) : null,
        } satisfies SubtitleCandidate,
      ];
    });
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleDownload> {
    const token = await this.login();
    const link = await this.request(() =>
      this.http
        .post("download", { json: { file_id: Number(candidate.providerId) }, headers: { Authorization: `Bearer ${token}` } })
        .json<DownloadResponse>(),
    );
    // The returned link is a plain, pre-signed file URL: no auth headers go with it.
    const bytes = await this.request(async () => new Uint8Array(await ky.get(link.link, { retry: 0, ...(this.options.fetchImpl ? { fetch: this.options.fetchImpl } : {}) }).arrayBuffer()));
    return { bytes, fileName: link.file_name ?? `${candidate.providerId}.${candidate.format}` };
  }

  private async login(): Promise<string> {
    if (this.token) return this.token;
    const response = await this.request(() =>
      this.http.post("login", { json: { username: this.options.username, password: this.options.password } }).json<{ token?: string }>(),
    );
    if (!response.token) throw new AuthFailedError(PROVIDER);
    this.token = response.token;
    return this.token;
  }

  /** Turns the API's HTTP failures into the provider errors the rest of the app understands. */
  private async request<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!isHTTPError(error)) throw error;
      const { status, headers } = error.response;
      if (status === 401 || status === 403) {
        this.token = null;
        throw new AuthFailedError(PROVIDER, { cause: error });
      }
      if (status === 429) {
        const retryAfter = Number(headers.get("retry-after"));
        throw new RateLimitedError(PROVIDER, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null, { cause: error });
      }
      // 406 is how the download endpoint says the daily allowance is spent.
      if (status === 406) throw new QuotaExhaustedError(PROVIDER, null, { cause: error });
      throw new SubtitleProviderError(PROVIDER, `OpenSubtitles request failed with ${status}`, { cause: error });
    }
  }
}
