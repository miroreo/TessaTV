import type { LibraryNode, SubtitleFile, SubtitleRepository, SubtitleSearchRecord, Unit } from "@tessatv/domain";
import { describe, expect, it, vi } from "vitest";
import { retryDelayMs, SubtitleAcquirer } from "./acquire.js";
import type { SubtitlePreference } from "./score.js";
import type { FetchOutcome } from "./subtitle-service.js";

const NOW = new Date("2026-01-10T00:00:00Z");
const DAY = 24 * 3600 * 1000;
const preference: SubtitlePreference = { language: "en", forced: false, hearingImpaired: "avoid" };
const wanted = { unitId: "u1", mediaFileId: "m1", videoPath: "/media/Show/Season 1/Show.S01E02.mkv" };

const series = { id: "n1", title: "The Show", parentId: null, externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "n1", providerId: "81189" }, { provider: "tmdb", entityType: "library_node", entityId: "n1", providerId: "1396" }] } as unknown as LibraryNode;
const season = { id: "n2", parentId: "n1", externalIds: [] } as unknown as LibraryNode;
const episodeNode = { id: "n3", parentId: "n2", externalIds: [] } as unknown as LibraryNode;
const episode = { id: "u1", libraryNodeId: "n3", sequence: { path: [1, 2] } } as unknown as Unit;

function memoryRepository() {
  const files: SubtitleFile[] = [];
  const records = new Map<string, SubtitleSearchRecord>();
  const blacklist: { provider: string; providerId: string }[] = [];
  const repository = {
    add: vi.fn(async (file: SubtitleFile) => void files.push(file)),
    getSearchRecord: vi.fn(async (unitId: string, slotKey: string) => records.get(`${unitId}/${slotKey}`) ?? null),
    saveSearchRecord: vi.fn(async (record: SubtitleSearchRecord) => void records.set(`${record.unitId}/${record.slotKey}`, record)),
    listBlacklisted: vi.fn(async () => blacklist),
  } as unknown as SubtitleRepository;
  return { repository, files, records, blacklist };
}

function setup(outcome: FetchOutcome, extra: Partial<ConstructorParameters<typeof SubtitleAcquirer>[0]> = {}) {
  const memory = memoryRepository();
  const fetchBest = vi.fn<(...args: unknown[]) => Promise<FetchOutcome>>(async () => outcome);
  const writeFile = vi.fn(async () => undefined);
  const acquirer = new SubtitleAcquirer({
    service: { fetchBest, earliestResume: () => null },
    library: { getUnit: async () => episode, getNode: async (id: string) => ({ n1: series, n2: season, n3: episodeNode })[id] ?? null },
    subtitles: memory.repository,
    writeFile,
    now: () => NOW,
    ...extra,
  });
  return { acquirer, fetchBest, writeFile, ...memory };
}

const found: FetchOutcome = {
  kind: "found",
  failures: [],
  subtitle: {
    text: "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    format: "srt",
    scored: { score: 80, accepted: true, signals: [], candidate: { provider: "opensubtitles", providerId: "9", language: "en", hearingImpaired: true } as never },
  },
};

describe("SubtitleAcquirer", () => {
  it("searches an episode by its series' ids, writes the sidecar and records it", async () => {
    const { acquirer, fetchBest, writeFile, files } = setup(found, { hashVideo: async () => "0123456789abcdef" });
    const result = await acquirer.acquire(wanted, preference);

    expect(result).toEqual({ kind: "downloaded", path: "/media/Show/Season 1/Show.S01E02.en.sdh.srt", score: 80 });
    expect(fetchBest.mock.calls[0]![0]).toMatchObject({
      kind: "episode", title: "The Show", season: 1, episode: 2, movieHash: "0123456789abcdef", fileName: "Show.S01E02.mkv",
      externalIds: { tmdb: "1396", tvdb: "81189" },
    });
    expect(writeFile).toHaveBeenCalledWith("/media/Show/Season 1/Show.S01E02.en.sdh.srt", found.kind === "found" ? found.subtitle.text : "");
    expect(files[0]).toMatchObject({ unitId: "u1", mediaFileId: "m1", language: "en", source: "downloaded", provider: "opensubtitles", providerId: "9", score: 80 });
  });

  it("skips the search when the video already carries the track", async () => {
    const { acquirer, fetchBest, records } = setup(found, { embeddedTracks: async () => [{ language: "en", forced: false }] });
    expect(await acquirer.acquire(wanted, preference)).toEqual({ kind: "embedded" });
    expect(fetchBest).not.toHaveBeenCalled();
    expect(records.get("u1/en")).toMatchObject({ outcome: "embedded", retryAfter: new Date(NOW.getTime() + 30 * DAY) });
  });

  it("does not take an embedded forced track for a full one", async () => {
    const { acquirer, fetchBest } = setup(found, { embeddedTracks: async () => [{ language: "en", forced: true }] });
    await acquirer.acquire(wanted, preference);
    expect(fetchBest).toHaveBeenCalled();
  });

  it("backs off further after each miss", async () => {
    const { acquirer, records } = setup({ kind: "none", considered: 0, failures: [] });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await acquirer.acquire(wanted, preference);
      delays.push((records.get("u1/en")!.retryAfter.getTime() - NOW.getTime()) / DAY);
    }
    expect(delays).toEqual([1, 3, 7, 30, 30]);
    expect(records.get("u1/en")!.attempts).toBe(5);
  });

  it("does not count a provider outage as a miss, and retries when a provider is back", async () => {
    const memory = memoryRepository();
    const resume = new Date(NOW.getTime() + 2 * 3600 * 1000);
    const acquirer = new SubtitleAcquirer({
      service: { fetchBest: async () => ({ kind: "unavailable", failures: [] }), earliestResume: () => resume },
      library: { getUnit: async () => episode, getNode: async (id: string) => ({ n1: series, n2: season, n3: episodeNode })[id] ?? null },
      subtitles: memory.repository, writeFile: async () => undefined, now: () => NOW,
    });
    expect(await acquirer.acquire(wanted, preference)).toEqual({ kind: "unavailable", retryAfter: resume });
    expect(memory.records.get("u1/en")).toMatchObject({ outcome: "unavailable", attempts: 0 });
  });

  it("keeps blacklisted candidates out of the search", async () => {
    const { acquirer, fetchBest, blacklist } = setup(found);
    blacklist.push({ provider: "opensubtitles", providerId: "9" });
    await acquirer.acquire(wanted, preference);
    const exclude = fetchBest.mock.calls[0]![2] as (candidate: { provider: string; providerId: string }) => boolean;
    expect(exclude({ provider: "opensubtitles", providerId: "9" })).toBe(true);
    expect(exclude({ provider: "opensubtitles", providerId: "10" })).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("is 1, 3, 7 days and then monthly", () => {
    expect([1, 2, 3, 4, 9].map((n) => retryDelayMs(n) / DAY)).toEqual([1, 3, 7, 30, 30]);
  });
});
