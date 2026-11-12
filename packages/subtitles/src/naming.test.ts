import { describe, expect, it } from "vitest";
import { normalizeLanguage } from "./language.js";
import { parseSidecarName, sidecarPath } from "./naming.js";

describe("sidecarPath", () => {
  it("builds Jellyfin/Plex style names", () => {
    const video = "/media/Movies/Movie (2020)/Movie (2020).mkv";
    expect(sidecarPath(video, { language: "en", forced: false, hearingImpaired: false, extension: "srt" })).toBe("/media/Movies/Movie (2020)/Movie (2020).en.srt");
    expect(sidecarPath(video, { language: "pt-BR", forced: true, hearingImpaired: false, extension: "ass" })).toBe("/media/Movies/Movie (2020)/Movie (2020).pt-BR.forced.ass");
    expect(sidecarPath(video, { language: "en", forced: false, hearingImpaired: true, extension: "srt" })).toBe("/media/Movies/Movie (2020)/Movie (2020).en.sdh.srt");
  });
});

describe("parseSidecarName", () => {
  const parse = (name: string) => parseSidecarName("Show.S01E01.mkv", name, normalizeLanguage);

  it("reads language and flags back", () => {
    expect(parse("Show.S01E01.en.forced.srt")).toEqual({ language: "en", forced: true, hearingImpaired: false, extension: "srt" });
    expect(parse("Show.S01E01.eng.sdh.srt")).toEqual({ language: "en", forced: false, hearingImpaired: true, extension: "srt" });
    expect(parse("Show.S01E01.pt_BR.ass")).toEqual({ language: "pt-BR", forced: false, hearingImpaired: false, extension: "ass" });
  });

  it("ignores other videos' files, non-subtitles and names without a language", () => {
    expect(parse("Show.S01E02.en.srt")).toBeNull();
    expect(parse("Show.S01E01.en.nfo")).toBeNull();
    expect(parse("Show.S01E01.srt")).toBeNull();
    expect(parse("Show.S01E01.directors.cut.srt")).toBeNull();
    expect(parse("Show.S01E010.en.srt")).toBeNull();
  });
});
