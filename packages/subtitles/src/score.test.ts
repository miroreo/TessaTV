import { describe, expect, it } from "vitest";
import { MIN_ACCEPTED_SCORE, rankCandidates, scoreCandidate, type SubtitleSlot } from "./score.js";
import type { SubtitleCandidate, SubtitleQuery } from "./subtitle-provider.js";

const query: SubtitleQuery = {
  kind: "episode",
  languages: ["en"],
  externalIds: { tmdb: "1396" },
  title: "Example Show",
  year: null,
  season: 1,
  episode: 2,
  fileName: "Example.Show.S01E02.1080p.WEB-DL.x264-GRP.mkv",
};
const slot: SubtitleSlot = { language: "en", forced: false, hearingImpaired: "avoid" };

function candidate(overrides: Partial<SubtitleCandidate> = {}): SubtitleCandidate {
  return {
    provider: "p",
    providerId: "1",
    language: "en",
    format: "srt",
    forced: false,
    hearingImpaired: false,
    aiTranslated: false,
    machineTranslated: false,
    releaseName: null,
    matchedBy: ["tmdb"],
    season: 1,
    episode: 2,
    downloadCount: null,
    uploadedAt: null,
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("accepts an id and episode match with the right flags", () => {
    const scored = scoreCandidate(candidate(), query, slot)!;
    expect(scored.signals.map((s) => s.name)).toEqual(["id and episode match", "exact language", "hearing-impaired flag"]);
    expect(scored.score).toBe(70);
    expect(scored.accepted).toBe(true);
  });

  it("accepts a file hash match without any release name agreement", () => {
    const scored = scoreCandidate(candidate({ matchedBy: ["hash"], releaseName: "Something.Else.720p" }), query, slot)!;
    expect(scored.accepted).toBe(true);
    expect(scored.score).toBeGreaterThanOrEqual(100);
  });

  it("rewards a matching release group, source, resolution and codec", () => {
    const plain = scoreCandidate(candidate(), query, slot)!;
    const matching = scoreCandidate(candidate({ releaseName: "Example.Show.S01E02.1080p.WEB-DL.x264-GRP" }), query, slot)!;
    expect(matching.score - plain.score).toBe(15 + 10 + 5 + 5);
  });

  it("never accepts the wrong episode", () => {
    const scored = scoreCandidate(candidate({ episode: 3 }), query, slot)!;
    expect(scored.accepted).toBe(false);
    expect(scored.signals[0]).toEqual({ name: "wrong episode", points: -100 });
  });

  it("never accepts a forced track for a full-subtitle slot, or the reverse", () => {
    expect(scoreCandidate(candidate({ forced: true }), query, slot)!.accepted).toBe(false);
    expect(scoreCandidate(candidate(), query, { ...slot, forced: true })!.accepted).toBe(false);
  });

  it("drops another language entirely, but keeps a regional variant of the wanted one", () => {
    expect(scoreCandidate(candidate({ language: "fr" }), query, slot)).toBeNull();
    const regional = scoreCandidate(candidate({ language: "pt-BR" }), query, { ...slot, language: "pt" })!;
    expect(regional.signals.map((s) => s.name)).not.toContain("exact language");
    expect(regional.accepted).toBe(true);
  });

  it("penalizes a hearing-impaired track when the slot wants to avoid them, and the reverse", () => {
    const avoid = scoreCandidate(candidate({ hearingImpaired: true }), query, slot)!;
    const prefer = scoreCandidate(candidate({ hearingImpaired: true }), query, { ...slot, hearingImpaired: "prefer" })!;
    expect(prefer.score - avoid.score).toBe(20);
  });

  it("pushes machine-translated subtitles below the threshold", () => {
    expect(scoreCandidate(candidate({ machineTranslated: true }), query, slot)!.score).toBeLessThan(MIN_ACCEPTED_SCORE);
  });

  it("does not accept a title-only movie match", () => {
    const movie: SubtitleQuery = { ...query, kind: "movie", fileName: "Movie.2020.mkv" };
    expect(scoreCandidate(candidate({ matchedBy: ["title"], season: null, episode: null }), movie, slot)!.accepted).toBe(false);
  });
});

describe("rankCandidates", () => {
  it("orders best first, breaks ties by downloads, and omits other languages", () => {
    const ranked = rankCandidates(
      [
        candidate({ providerId: "low", downloadCount: 10 }),
        candidate({ providerId: "fr", language: "fr" }),
        candidate({ providerId: "high", downloadCount: 20 }),
        candidate({ providerId: "group", releaseName: "Example.Show.S01E02.1080p.WEB-DL.x264-GRP" }),
      ],
      query,
      slot,
    );
    expect(ranked.map((r) => r.candidate.providerId)).toEqual(["group", "high", "low"]);
  });
});
