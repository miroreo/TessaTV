import type { SubtitleSlot } from "@tessatv/domain";
import { filenameParse } from "@ctrl/video-filename-parser";
import { primaryLanguage } from "./language.js";
import type { SubtitleCandidate, SubtitleQuery } from "./subtitle-provider.js";

/** What one fetch is trying to fill: a slot (language, forced or full) and how to treat SDH tracks. */
export interface SubtitlePreference extends SubtitleSlot {
  readonly hearingImpaired: "prefer" | "avoid" | "any";
}

export interface ScoreSignal {
  readonly name: string;
  readonly points: number;
}

export interface ScoredCandidate {
  readonly candidate: SubtitleCandidate;
  readonly score: number;
  /** Why it scored what it did, for the UI's "why this one". */
  readonly signals: readonly ScoreSignal[];
  /** Whether it is good enough to download without a person choosing. */
  readonly accepted: boolean;
}

/** Below this a candidate is shown but never downloaded automatically. */
export const MIN_ACCEPTED_SCORE = 60;

// Starting weights, to be tuned against real libraries. Hash match is decisive on its own;
// a wrong season/episode or a wrong forced flag sinks a candidate below the threshold.
const POINTS = {
  hash: 100,
  idWithEpisode: 50,
  // A movie has no episode to line up, so an id match is as strong as it gets short of the hash.
  movieId: 50,
  idOnly: 40,
  titleWithEpisode: 30,
  episodeMismatch: -100,
  forcedMismatch: -100,
  releaseGroup: 15,
  source: 10,
  resolution: 5,
  videoCodec: 5,
  exactLanguage: 10,
  languageVariant: 5,
  hearingImpaired: 10,
  hearingImpairedWrong: -10,
  machineTranslated: -30,
  maxPopularity: 10,
} as const;

function parseRelease(name: string, isTv: boolean) {
  // A release name has no extension to drop (its last dot-part may be the group), a file name does.
  const parsed = filenameParse(name.replace(/\.(mkv|mp4|avi|m4v|ts|wmv|mov|srt|ass|ssa|vtt|sub|zip)$/i, ""), isTv);
  return { group: parsed.group?.toLowerCase() ?? null, sources: parsed.sources, resolution: parsed.resolution, videoCodec: parsed.videoCodec };
}

/** The best an id-based or title-based match can be known to line up with the wanted episode. */
function matchSignals(candidate: SubtitleCandidate, query: SubtitleQuery): ScoreSignal[] {
  if (candidate.matchedBy.includes("hash")) return [{ name: "file hash", points: POINTS.hash }];
  const byId = candidate.matchedBy.some((m) => m === "imdb" || m === "tmdb" || m === "tvdb");
  if (query.kind === "movie") {
    return byId ? [{ name: "id match", points: POINTS.movieId }] : [];
  }
  const known = candidate.season !== null && candidate.episode !== null;
  if (known && (candidate.season !== query.season || candidate.episode !== query.episode)) {
    return [{ name: "wrong episode", points: POINTS.episodeMismatch }];
  }
  if (!known) return byId ? [{ name: "id match", points: POINTS.idOnly }] : [];
  return [byId ? { name: "id and episode match", points: POINTS.idWithEpisode } : { name: "title and episode match", points: POINTS.titleWithEpisode }];
}

function releaseSignals(candidate: SubtitleCandidate, query: SubtitleQuery): ScoreSignal[] {
  if (!candidate.releaseName) return [];
  const isTv = query.kind === "episode";
  const wanted = parseRelease(query.fileName, isTv);
  const offered = parseRelease(candidate.releaseName, isTv);
  const signals: ScoreSignal[] = [];
  if (wanted.group && wanted.group === offered.group) signals.push({ name: "release group", points: POINTS.releaseGroup });
  if (wanted.sources.some((source) => offered.sources.includes(source))) signals.push({ name: "source", points: POINTS.source });
  if (wanted.resolution && wanted.resolution === offered.resolution) signals.push({ name: "resolution", points: POINTS.resolution });
  if (wanted.videoCodec && wanted.videoCodec === offered.videoCodec) signals.push({ name: "video codec", points: POINTS.videoCodec });
  return signals;
}

/**
 * Scores one candidate for one slot, or returns null if it can never be right (another
 * language). Pure: the same inputs always rank the same way, which is what makes it testable.
 */
export function scoreCandidate(candidate: SubtitleCandidate, query: SubtitleQuery, slot: SubtitlePreference): ScoredCandidate | null {
  if (primaryLanguage(candidate.language) !== primaryLanguage(slot.language)) return null;

  const signals: ScoreSignal[] = [...matchSignals(candidate, query)];
  signals.push(candidate.language === slot.language ? { name: "exact language", points: POINTS.exactLanguage } : { name: "language variant", points: POINTS.languageVariant });

  if (candidate.forced !== slot.forced) signals.push({ name: "wrong forced flag", points: POINTS.forcedMismatch });

  if (slot.hearingImpaired !== "any") {
    const wantsHi = slot.hearingImpaired === "prefer";
    signals.push(candidate.hearingImpaired === wantsHi ? { name: "hearing-impaired flag", points: POINTS.hearingImpaired } : { name: "hearing-impaired mismatch", points: POINTS.hearingImpairedWrong });
  }
  if (candidate.machineTranslated || candidate.aiTranslated) signals.push({ name: "machine translated", points: POINTS.machineTranslated });

  signals.push(...releaseSignals(candidate, query));

  if (candidate.downloadCount !== null && candidate.downloadCount > 0) {
    // Log scale, so a few thousand downloads isn't ten times better than a few hundred.
    const points = Math.min(POINTS.maxPopularity, Math.round(Math.log10(candidate.downloadCount + 1) * 3));
    signals.push({ name: "popularity", points });
  }

  const score = signals.reduce((sum, signal) => sum + signal.points, 0);
  const hashed = candidate.matchedBy.includes("hash");
  return { candidate, score, signals, accepted: hashed ? score >= POINTS.hash : score >= MIN_ACCEPTED_SCORE };
}

/** Every candidate that could fit the slot, best first; ties go to the more downloaded one. */
export function rankCandidates(candidates: readonly SubtitleCandidate[], query: SubtitleQuery, slot: SubtitlePreference): ScoredCandidate[] {
  return candidates
    .flatMap((candidate) => scoreCandidate(candidate, query, slot) ?? [])
    .sort((a, b) => b.score - a.score || (b.candidate.downloadCount ?? 0) - (a.candidate.downloadCount ?? 0));
}
