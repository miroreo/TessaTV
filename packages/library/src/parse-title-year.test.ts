import { describe, expect, it } from "vitest";
import { normalizeSeriesTitle, parseTitleAndYear } from "./parse-title-year.js";

describe("parseTitleAndYear", () => {
  it("splits a Radarr-style 'Title (Year)' folder name", () => {
    expect(parseTitleAndYear("Example Movie (1999)")).toEqual({ title: "Example Movie", year: 1999 });
  });

  it("falls back to the whole name with a null year when there is no year suffix", () => {
    expect(parseTitleAndYear("Untitled Folder")).toEqual({ title: "Untitled Folder", year: null });
  });

  it("strips a trailing Jellyfin/Radarr-style provider-id tag before looking for the year", () => {
    expect(parseTitleAndYear("Example Movie (1999) {tmdb-603}")).toEqual({ title: "Example Movie", year: 1999 });
    expect(parseTitleAndYear("Example Movie (1999) [imdbid-tt0137523]")).toEqual({
      title: "Example Movie",
      year: 1999,
    });
  });

  it("strips multiple chained provider-id tags", () => {
    expect(parseTitleAndYear("Example Movie (1999) {tmdb-603}{imdb-tt0137523}")).toEqual({
      title: "Example Movie",
      year: 1999,
    });
  });
});

describe("normalizeSeriesTitle", () => {
  it("replaces dot/underscore separators with spaces", () => {
    expect(normalizeSeriesTitle("Example.Show.Name")).toBe("Example Show Name");
    expect(normalizeSeriesTitle("Another_Show_Title")).toBe("Another Show Title");
  });

  it("strips a trailing year and collapses repeated separators", () => {
    expect(normalizeSeriesTitle("Example..Show (2012)")).toBe("Example Show");
  });
});
