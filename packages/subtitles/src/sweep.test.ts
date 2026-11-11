import type { WantedSubtitle } from "@tessatv/domain";
import { describe, expect, it, vi } from "vitest";
import type { AcquireResult } from "./acquire.js";
import type { SubtitlePreference } from "./score.js";
import { sweepSubtitles } from "./sweep.js";

const en: SubtitlePreference = { language: "en", forced: false, hearingImpaired: "avoid" };
const fr: SubtitlePreference = { language: "fr", forced: false, hearingImpaired: "avoid" };
const unit = (id: string): WantedSubtitle => ({ unitId: id, mediaFileId: `m-${id}`, videoPath: `/${id}.mkv` });

function sweep(results: Record<string, AcquireResult | Error>, wanted: Record<string, WantedSubtitle[]>, extra: Partial<Parameters<typeof sweepSubtitles>[0]> = {}) {
  const acquire = vi.fn(async (u: WantedSubtitle) => {
    const result = results[u.unitId]!;
    if (result instanceof Error) throw result;
    return result;
  });
  const listWanting = vi.fn(async (preference: SubtitlePreference) => wanted[preference.language] ?? []);
  return { acquire, listWanting, run: () => sweepSubtitles({ subtitles: { listWanting }, acquirer: { acquire }, preferences: [en, fr], budgetMs: 60_000, ...extra }) };
}

const retryAfter = new Date();

describe("sweepSubtitles", () => {
  it("fills every wanted slot and counts the outcomes, carrying on past a failed unit", async () => {
    const onError = vi.fn();
    const { run, acquire } = sweep(
      { a: { kind: "downloaded", path: "/a.en.srt", score: 70 }, b: { kind: "embedded" }, c: { kind: "none", retryAfter }, d: new Error("disk full"), e: { kind: "downloaded", path: "/e.fr.srt", score: 70 } },
      { en: [unit("a"), unit("b"), unit("c"), unit("d")], fr: [unit("e")] },
      { onError },
    );
    expect(await run()).toEqual({ downloaded: 2, embedded: 1, notFound: 1, unavailable: 0, failed: 1 });
    expect(acquire).toHaveBeenCalledTimes(5);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "d");
  });

  it("stops when the providers are all out instead of trying every unit", async () => {
    const { run, acquire } = sweep({ a: { kind: "unavailable", retryAfter }, b: { kind: "downloaded", path: "x", score: 1 } }, { en: [unit("a"), unit("b")], fr: [unit("b")] });
    expect(await run()).toMatchObject({ unavailable: 1, downloaded: 0 });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("stops starting units once the time budget is spent", async () => {
    let tick = 0;
    const { run, acquire } = sweep({ a: { kind: "none", retryAfter }, b: { kind: "none", retryAfter } }, { en: [unit("a"), unit("b")] }, { budgetMs: 1000, now: () => new Date(tick++ * 600) });
    await run();
    expect(acquire.mock.calls.length).toBeLessThan(2);
  });
});
