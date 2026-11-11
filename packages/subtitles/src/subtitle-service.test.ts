import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { QuotaExhaustedError, RateLimitedError } from "./errors.js";
import type { SubtitleSlot } from "./score.js";
import { SubtitleService } from "./subtitle-service.js";
import type { SubtitleCandidate, SubtitleProvider, SubtitleQuery } from "./subtitle-provider.js";

const query: SubtitleQuery = { kind: "movie", languages: ["en"], externalIds: { tmdb: "1" }, title: "Movie", year: 2020, fileName: "Movie.2020.mkv" };
const slot: SubtitleSlot = { language: "en", forced: false, hearingImpaired: "any" };
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";

function candidate(provider: string, providerId: string, overrides: Partial<SubtitleCandidate> = {}): SubtitleCandidate {
  return {
    provider, providerId, language: "en", format: "srt", forced: false, hearingImpaired: false, aiTranslated: false, machineTranslated: false,
    releaseName: null, matchedBy: ["tmdb"], season: null, episode: null, downloadCount: null, uploadedAt: null, ...overrides,
  };
}

function fakeProvider(id: string, candidates: SubtitleCandidate[], download: SubtitleProvider["download"] = async () => ({ bytes: strToU8(SRT), fileName: "a.srt" })): SubtitleProvider & { search: ReturnType<typeof vi.fn> } {
  return { id, capabilities: { hashSearch: false }, search: vi.fn(async () => candidates), download: vi.fn(download) };
}

const fast = { minTimeMs: 0 };

describe("SubtitleService", () => {
  it("downloads the best candidate across providers and decodes it", async () => {
    const weak = fakeProvider("a", [candidate("a", "1", { matchedBy: ["title"] })]);
    const strong = fakeProvider("b", [candidate("b", "2")]);
    const outcome = await new SubtitleService([weak, strong], fast).fetchBest(query, slot);
    expect(outcome.kind).toBe("found");
    if (outcome.kind === "found") {
      expect(outcome.subtitle.text).toBe(SRT);
      expect(outcome.subtitle.scored.candidate.provider).toBe("b");
    }
    expect(weak.download).not.toHaveBeenCalled();
  });

  it("searches for the slot's language and flavor, whatever the query said", async () => {
    const provider = fakeProvider("a", []);
    await new SubtitleService([provider], fast).search({ ...query, languages: ["fr"] }, { ...slot, forced: true });
    expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ languages: ["en"], forced: true }));
  });

  it("says none when only unacceptable candidates exist, and does not download them", async () => {
    const provider = fakeProvider("a", [candidate("a", "1", { matchedBy: ["title"] })]);
    const outcome = await new SubtitleService([provider], fast).fetchBest(query, slot);
    expect(outcome).toMatchObject({ kind: "none", considered: 1 });
    expect(provider.download).not.toHaveBeenCalled();
  });

  it("falls through to the next candidate when a download is unusable", async () => {
    let calls = 0;
    const provider = fakeProvider("a", [candidate("a", "1", { downloadCount: 100 }), candidate("a", "2")], async () => ({ bytes: strToU8(calls++ === 0 ? "" : SRT), fileName: "a.srt" }));
    const outcome = await new SubtitleService([provider], fast).fetchBest(query, slot);
    expect(outcome.kind).toBe("found");
    expect(provider.download).toHaveBeenCalledTimes(2);
  });

  it("pauses a provider that is out of quota and keeps using the others", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const spent = fakeProvider("a", [candidate("a", "1", { downloadCount: 100 })], async () => {
      throw new QuotaExhaustedError("a", null);
    });
    const other = fakeProvider("b", [candidate("b", "2")]);
    const service = new SubtitleService([spent, other], { ...fast, now: () => now });

    expect((await service.fetchBest(query, slot)).kind).toBe("found");
    expect(service.earliestResume()).toEqual(new Date("2026-01-02T00:00:00Z"));

    await service.search(query, slot);
    expect(spent.search).toHaveBeenCalledTimes(1);
    now = new Date("2026-01-02T00:00:01Z");
    await service.search(query, slot);
    expect(spent.search).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable, not none, when every provider is failing", async () => {
    const provider = fakeProvider("a", []);
    provider.search.mockRejectedValue(new RateLimitedError("a", 30));
    const service = new SubtitleService([provider], fast);
    expect(await service.fetchBest(query, slot)).toMatchObject({ kind: "unavailable" });
    expect(await service.fetchBest(query, slot)).toMatchObject({ kind: "unavailable" });
    expect(provider.search).toHaveBeenCalledTimes(1);
  });
});
