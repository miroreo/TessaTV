export type SubtitleFormat = "srt" | "ass" | "ssa" | "vtt" | "sub" | "zip";

/** One subtitle a provider offers, in a provider-neutral shape. */
export interface SubtitleCandidate {
  readonly provider: string;
  /** Whatever the provider needs to download it again (OpenSubtitles: the file id). */
  readonly providerId: string;
  /** Normalized by `normalizeLanguage`. */
  readonly language: string;
  readonly format: SubtitleFormat;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
  readonly aiTranslated: boolean;
  readonly machineTranslated: boolean;
  /** What the uploader says the subtitle was timed to, e.g. `Show.S01E02.1080p.WEB-DL.x264-GRP`. */
  readonly releaseName: string | null;
  readonly matchedBy: readonly ("hash" | "imdb" | "tmdb" | "tvdb" | "title")[];
  /** What the provider says the subtitle is for; null when it doesn't say. */
  readonly season: number | null;
  readonly episode: number | null;
  readonly downloadCount: number | null;
  readonly uploadedAt: Date | null;
}

export interface SubtitleQuery {
  readonly kind: "movie" | "episode";
  /** Normalized languages wanted, most preferred first. */
  readonly languages: readonly string[];
  /** For an episode these are the *series'* ids. Ids a provider can't search by are ignored. */
  readonly externalIds: { readonly tmdb?: string; readonly imdb?: string; readonly tvdb?: string };
  readonly title: string;
  readonly year: number | null;
  readonly season?: number;
  readonly episode?: number;
  /** OpenSubtitles' 64-bit file hash, when computed. */
  readonly movieHash?: string;
  /** Basename only. It's parsed for release group, source and so on, and never sent to providers. */
  readonly fileName: string;
  readonly allowMachineTranslated?: boolean;
  /** Ask only for forced (foreign-parts-only) subtitles, or exclude them. */
  readonly forced?: boolean;
}

export interface SubtitleDownload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

export interface SubtitleProvider {
  readonly id: string;
  readonly capabilities: { readonly hashSearch: boolean };
  /** Throws a `SubtitleProviderError` subclass on rate limit, quota or credential trouble. */
  search(query: SubtitleQuery): Promise<SubtitleCandidate[]>;
  download(candidate: SubtitleCandidate): Promise<SubtitleDownload>;
}
