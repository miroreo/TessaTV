import { describe, expect, it } from "vitest";
import { parseEpisodeFilename } from "./parse-episode.js";

describe("parseEpisodeFilename", () => {
  it("extracts season, episode, and a cleaned-up title before the quality marker", () => {
    expect(parseEpisodeFilename("Example.Show.S01E02.The.Second.One.Bluray-720p.mkv")).toEqual({
      season: 1,
      episode: 2,
      title: "The Second One",
    });
  });

  it("handles a two-digit season/episode and a WEBDL-style quality marker", () => {
    expect(parseEpisodeFilename("Another.Show.S12E09.Some.Title.WEBDL-1080p.mp4")).toEqual({
      season: 12,
      episode: 9,
      title: "Some Title",
    });
  });

  it("falls back to a generic 'Episode N' title when nothing is left after the SxxExx token", () => {
    expect(parseEpisodeFilename("Show.S01E01.720p.mkv")).toEqual({
      season: 1,
      episode: 1,
      title: "Episode 1",
    });
  });

  it("returns null when the filename has no recognizable episode token at all", () => {
    expect(parseEpisodeFilename("random-file-name.mkv")).toBeNull();
  });

  it("falls back to absolute/anime-style numbering with a dash-delimited title when there is no SxxExx token", () => {
    expect(
      parseEpisodeFilename("[Group] Some Anime - 08 - The Big Fight (1080p AV1 10Bit BluRay OPUS) [ABCDEF12].mkv"),
    ).toEqual({ season: 1, episode: 8, title: "The Big Fight" });
  });

  it("falls back to absolute/anime-style numbering with no title segment before the quality info", () => {
    expect(parseEpisodeFilename("[Group] Another Anime 01 (BD 1080p AV1) [12345678].mkv")).toEqual({
      season: 1,
      episode: 1,
      title: "Episode 1",
    });
  });

  it("picks the number closest to the quality info, not an incidental earlier digit in the title", () => {
    expect(parseEpisodeFilename("[Group] Show 2 (uncut) 05 (1080p) [HASH].mkv")).toEqual({
      season: 1,
      episode: 5,
      title: "Episode 5",
    });
  });

  it("handles the legacy 'NxEE' convention (e.g. Kodi/XBMC-style, predates SxxExx)", () => {
    expect(parseEpisodeFilename("Legacy.Show.1x05.An.Old.Title.DVDRip.avi")).toEqual({
      season: 1,
      episode: 5,
      title: "An Old Title",
    });
    expect(parseEpisodeFilename("Legacy.Show.12x09.Another.Title.mkv")).toEqual({
      season: 12,
      episode: 9,
      title: "Another Title",
    });
  });

  it("does not misread a resolution tag like 1920x1080 as an NxEE episode token", () => {
    expect(parseEpisodeFilename("Random.Clip.1920x1080.mkv")).toBeNull();
  });
});
