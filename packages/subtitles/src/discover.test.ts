import type { SubtitleFile, WantedSubtitle } from "@tessatv/domain";
import { describe, expect, it, vi } from "vitest";
import { discoverSidecars } from "./discover.js";

const video = (unitId: string, videoPath: string): WantedSubtitle => ({ unitId, mediaFileId: `m-${unitId}`, videoPath });
const record = (overrides: Partial<SubtitleFile>): SubtitleFile => ({
  id: "r1", unitId: "u1", mediaFileId: "m-u1", language: "en", forced: false, hearingImpaired: false, source: "downloaded",
  provider: "opensubtitles", providerId: "9", score: 70, path: "/tv/A.S01E01.en.srt", format: "srt", createdAt: new Date(0), ...overrides,
});

function setup(files: SubtitleFile[], videos: WantedSubtitle[], disk: Record<string, string[] | null>) {
  const added: SubtitleFile[] = [];
  const subtitles = {
    listAll: async () => files,
    listPlayableFiles: async () => videos,
    add: vi.fn(async (file: SubtitleFile) => void added.push(file)),
    remove: vi.fn(async () => undefined),
    blacklist: vi.fn(async () => undefined),
  };
  const listDirectory = vi.fn(async (directory: string) => disk[directory] ?? null);
  return { subtitles, listDirectory, added, run: () => discoverSidecars({ subtitles, listDirectory, now: () => new Date(5) }) };
}

describe("discoverSidecars", () => {
  it("records subtitle files beside each video, reading each directory once", async () => {
    const { run, added, listDirectory } = setup(
      [],
      [video("u1", "/tv/A.S01E01.mkv"), video("u2", "/tv/A.S01E02.mkv")],
      { "/tv": ["A.S01E01.mkv", "A.S01E01.en.srt", "A.S01E01.fr.forced.ass", "A.S01E02.eng.sdh.srt", "notes.txt"] },
    );
    expect(await run()).toEqual({ added: 3, removed: 0 });
    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(added.map((f) => [f.unitId, f.language, f.forced, f.hearingImpaired, f.format, f.source, f.path])).toEqual([
      ["u1", "en", false, false, "srt", "sidecar-found", "/tv/A.S01E01.en.srt"],
      ["u1", "fr", true, false, "ass", "sidecar-found", "/tv/A.S01E01.fr.forced.ass"],
      ["u2", "en", false, true, "srt", "sidecar-found", "/tv/A.S01E02.eng.sdh.srt"],
    ]);
  });

  it("does not record a file it already knows", async () => {
    const { run } = setup([record({})], [video("u1", "/tv/A.S01E01.mkv")], { "/tv": ["A.S01E01.en.srt"] });
    expect(await run()).toEqual({ added: 0, removed: 0 });
  });

  it("drops a record whose file is gone, and blacklists a downloaded one so it isn't fetched again", async () => {
    const { run, subtitles } = setup([record({}), record({ id: "r2", source: "sidecar-found", provider: null, providerId: null, path: "/tv/A.S01E01.fr.srt" })], [video("u1", "/tv/A.S01E01.mkv")], { "/tv": ["A.S01E01.mkv"] });
    expect(await run()).toEqual({ added: 0, removed: 2 });
    expect(subtitles.remove).toHaveBeenCalledTimes(2);
    expect(subtitles.blacklist).toHaveBeenCalledTimes(1);
    expect(subtitles.blacklist).toHaveBeenCalledWith("u1", "opensubtitles", "9");
  });

  it("skips a directory it can't read, and keeps the records there (an offline share must not wipe them)", async () => {
    const { run, added, subtitles } = setup([record({ path: "/mnt/offline/A.en.srt" })], [video("u1", "/mnt/offline/A.mkv")], {});
    expect(await run()).toEqual({ added: 0, removed: 0 });
    expect(added).toEqual([]);
    expect(subtitles.remove).not.toHaveBeenCalled();
    expect(subtitles.blacklist).not.toHaveBeenCalled();
  });
});
