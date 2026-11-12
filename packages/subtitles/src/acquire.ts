import {
  subtitleSlotKey,
  type LibraryNode,
  type LibraryRepository,
  type SubtitleRepository,
  type Unit,
  type WantedSubtitle,
} from "@tessatv/domain";
import { randomUUID } from "node:crypto";
import { sidecarPath } from "./naming.js";
import type { SubtitlePreference } from "./score.js";
import type { SubtitleService } from "./subtitle-service.js";
import type { SubtitleQuery } from "./subtitle-provider.js";

export interface EmbeddedSubtitleTrack {
  /** Normalized, or null when the track has no usable language tag. */
  readonly language: string | null;
  readonly forced: boolean;
}

export interface SubtitleAcquirerDeps {
  readonly service: Pick<SubtitleService, "fetchBest" | "earliestResume">;
  readonly library: Pick<LibraryRepository, "getUnit" | "getNode">;
  readonly subtitles: SubtitleRepository;
  /** The video's embedded *text* subtitle tracks; leave out to ignore embedded tracks. */
  readonly embeddedTracks?: (videoPath: string) => Promise<readonly EmbeddedSubtitleTrack[]>;
  /** OpenSubtitles file hash of the video, when it can be computed. */
  readonly hashVideo?: (videoPath: string) => Promise<string | null>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly now?: () => Date;
}

export type AcquireResult =
  | { readonly kind: "downloaded"; readonly path: string; readonly score: number }
  | { readonly kind: "embedded" }
  | { readonly kind: "none"; readonly retryAfter: Date }
  | { readonly kind: "unavailable"; readonly retryAfter: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Subtitles for a new release often take days to appear, so a miss is retried after 1 day, then
 * 3, then 7, then monthly. `attempts` counts the misses so far, including the one just made.
 */
export function retryDelayMs(attempts: number): number {
  return ([1, 3, 7][attempts - 1] ?? 30) * DAY_MS;
}

/** The series (or the movie itself) a unit hangs under: that's where the external ids live. */
async function rootNode(library: SubtitleAcquirerDeps["library"], unit: Unit): Promise<LibraryNode | null> {
  let node = await library.getNode(unit.libraryNodeId);
  for (let depth = 0; node?.parentId && depth < 10; depth++) node = await library.getNode(node.parentId);
  return node;
}

function idFor(node: LibraryNode, provider: string): string | undefined {
  return node.externalIds.find((id) => id.provider === provider)?.providerId;
}

/**
 * Fills one subtitle slot for one unit: skip if the video already has the track, otherwise
 * search, download the best acceptable candidate, write it beside the video and record it. A
 * miss is recorded with when to look again; nothing here throws for a provider being down.
 */
export class SubtitleAcquirer {
  private readonly now: () => Date;

  constructor(private readonly deps: SubtitleAcquirerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async acquire(wanted: WantedSubtitle, preference: SubtitlePreference, options: { allowMachineTranslated?: boolean } = {}): Promise<AcquireResult> {
    const { library, subtitles, service } = this.deps;
    const slotKey = subtitleSlotKey(preference);
    const now = this.now();
    const unit = await library.getUnit(wanted.unitId);
    const root = unit ? await rootNode(library, unit) : null;
    if (!unit || !root) throw new Error(`Unit ${wanted.unitId} is no longer in the library`);

    const embedded = await this.embeddedMatch(wanted.videoPath, preference);
    const previous = await subtitles.getSearchRecord(wanted.unitId, slotKey);
    if (embedded) {
      const retryAfter = new Date(now.getTime() + 30 * DAY_MS);
      await subtitles.saveSearchRecord({ unitId: wanted.unitId, slotKey, outcome: "embedded", attempts: 0, attemptedAt: now, retryAfter });
      return { kind: "embedded" };
    }

    const [season, episode] = unit.sequence.path;
    const isEpisode = season !== undefined && episode !== undefined;
    const tmdb = idFor(root, "tmdb");
    const tvdb = idFor(root, "tvdb");
    const imdb = idFor(root, "imdb");
    const movieHash = await this.deps.hashVideo?.(wanted.videoPath);
    const fileName = wanted.videoPath.split("/").pop() ?? wanted.videoPath;
    const query: SubtitleQuery = {
      kind: isEpisode ? "episode" : "movie",
      languages: [preference.language],
      externalIds: { ...(tmdb ? { tmdb } : {}), ...(tvdb ? { tvdb } : {}), ...(imdb ? { imdb } : {}) },
      title: root.title,
      year: null,
      ...(isEpisode ? { season, episode } : {}),
      ...(movieHash ? { movieHash } : {}),
      fileName,
      ...(options.allowMachineTranslated ? { allowMachineTranslated: true } : {}),
    };

    const blacklisted = await subtitles.listBlacklisted(wanted.unitId);
    const outcome = await service.fetchBest(query, preference, (candidate) =>
      blacklisted.some((entry) => entry.provider === candidate.provider && entry.providerId === candidate.providerId),
    );

    if (outcome.kind === "found") {
      const { scored, text, format } = outcome.subtitle;
      const { candidate } = scored;
      const path = sidecarPath(wanted.videoPath, { language: candidate.language, forced: preference.forced, hearingImpaired: candidate.hearingImpaired, extension: format });
      await this.deps.writeFile(path, text);
      await subtitles.add({
        id: randomUUID(), unitId: wanted.unitId, mediaFileId: wanted.mediaFileId, language: candidate.language, forced: preference.forced,
        hearingImpaired: candidate.hearingImpaired, source: "downloaded", provider: candidate.provider, providerId: candidate.providerId,
        score: scored.score, path, format, createdAt: now,
      });
      return { kind: "downloaded", path, score: scored.score };
    }

    if (outcome.kind === "unavailable") {
      // Nothing was learned, so it isn't a miss: look again when a paused provider is back, or soon.
      const retryAfter = service.earliestResume() ?? new Date(now.getTime() + 60 * 60 * 1000);
      await subtitles.saveSearchRecord({ unitId: wanted.unitId, slotKey, outcome: "unavailable", attempts: previous?.attempts ?? 0, attemptedAt: now, retryAfter });
      return { kind: "unavailable", retryAfter };
    }

    const attempts = (previous?.outcome === "none" ? previous.attempts : 0) + 1;
    const retryAfter = new Date(now.getTime() + retryDelayMs(attempts));
    await subtitles.saveSearchRecord({ unitId: wanted.unitId, slotKey, outcome: "none", attempts, attemptedAt: now, retryAfter });
    return { kind: "none", retryAfter };
  }

  private async embeddedMatch(videoPath: string, preference: SubtitlePreference): Promise<boolean> {
    if (!this.deps.embeddedTracks) return false;
    const tracks = await this.deps.embeddedTracks(videoPath);
    const wanted = preference.language.split("-")[0];
    return tracks.some((track) => track.language?.split("-")[0] === wanted && track.forced === preference.forced);
  }
}
