import { rename, writeFile } from "node:fs/promises";
import type { AppConfig } from "@tessatv/config";
import type { LibraryRepository, SubtitleRepository } from "@tessatv/domain";
import { probeMedia } from "@tessatv/streaming";
import {
  movieHash,
  normalizeLanguage,
  OpenSubtitlesProvider,
  parseSubtitlePreferences,
  SubtitleAcquirer,
  SubtitleService,
  sweepSubtitles,
  type SubtitleSweepSummary,
} from "@tessatv/subtitles";

export interface SubtitleJobDeps {
  readonly config: AppConfig;
  readonly library: LibraryRepository;
  readonly subtitles: SubtitleRepository;
  readonly warn: (details: object, message: string) => void;
  readonly version?: string;
}

/** Writes beside the final name and renames, so a player never reads half a subtitle. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.tessatv-tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

/**
 * The scheduled "fill in missing subtitles" run, or null when no provider is configured (the
 * feature is off rather than failing). Providers are added here as they get adapters.
 */
export function createSubtitleSweep(deps: SubtitleJobDeps): (() => Promise<SubtitleSweepSummary>) | null {
  const { config } = deps;
  if (!config.OPENSUBTITLES_API_KEY || !config.OPENSUBTITLES_USERNAME || !config.OPENSUBTITLES_PASSWORD) return null;

  const { preferences, invalid } = parseSubtitlePreferences(config.SUBTITLE_LANGUAGES, config.SUBTITLE_HEARING_IMPAIRED);
  if (invalid.length > 0) deps.warn({ invalid }, "SUBTITLE_LANGUAGES has entries that aren't languages (or repeat one); ignoring them");
  if (preferences.length === 0) return null;

  const service = new SubtitleService([
    new OpenSubtitlesProvider({
      apiKey: config.OPENSUBTITLES_API_KEY,
      username: config.OPENSUBTITLES_USERNAME,
      password: config.OPENSUBTITLES_PASSWORD,
      // Generic on purpose: nothing about this server or its owner goes to the provider.
      userAgent: `TessaTV v${deps.version ?? "0"}`,
    }),
  ]);
  const acquirer = new SubtitleAcquirer({
    service,
    library: deps.library,
    subtitles: deps.subtitles,
    embeddedTracks: async (path) => {
      const probe = await probeMedia(path);
      return probe.subtitleStreams
        .filter((stream) => stream.isTextBased)
        .map((stream) => ({ language: stream.language ? normalizeLanguage(stream.language) : null, forced: stream.isForced }));
    },
    hashVideo: movieHash,
    writeFile: writeAtomically,
  });

  return () =>
    sweepSubtitles({
      subtitles: deps.subtitles,
      acquirer,
      preferences,
      // Finishes inside pg-boss's default 15-minute job expiry, like the loudness scan.
      budgetMs: 10 * 60 * 1000,
      onError: (error, unitId) => deps.warn({ unitId, error: error instanceof Error ? error.message : String(error) }, "subtitle fetch failed"),
    });
}
