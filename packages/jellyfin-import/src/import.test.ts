import type { ImportedWatchProgress, UnitLocation } from "@tessatv/domain";
import { describe, expect, it } from "vitest";
import { importWatchHistory } from "./import.js";
import type { JellyfinHistorySource, JellyfinItem } from "./source.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const episode = (unitId: string, path: string, season: number, ep: number, tvdb: string): UnitLocation => ({
  unitId,
  mediaType: "series",
  path,
  sequencePath: [season, ep],
  externalIds: [{ provider: "tvdb", entityType: "library_node", entityId: "n", providerId: tvdb }],
});
const LOCATIONS: UnitLocation[] = [
  episode("u-s1e1", "/data/tessatv/shows/Show/Season 1/Show - S01E01.mkv", 1, 1, "500"),
  episode("u-s1e2", "/data/tessatv/shows/Show/Season 1/Show - S01E02.mkv", 1, 2, "500"),
  {
    unitId: "u-movie",
    mediaType: "movie",
    path: "/data/tessatv/movies/Heat (1995)/Heat.mkv",
    sequencePath: [],
    externalIds: [{ provider: "tmdb", entityType: "unit", entityId: "u-movie", providerId: "949" }],
  },
];

const item = (over: Partial<JellyfinItem>): JellyfinItem => ({
  id: "i",
  type: "Episode",
  path: null,
  providerIds: {},
  seriesId: null,
  seasonNumber: null,
  episodeNumber: null,
  runtimeSeconds: 1500,
  played: false,
  positionSeconds: 0,
  lastPlayedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

function run(history: Record<string, JellyfinItem[]>, accounts: Record<string, string>) {
  const imported: Record<string, ImportedWatchProgress[]> = {};
  const held: Record<string, ImportedWatchProgress[]> = {};
  const source: JellyfinHistorySource = {
    listUsers: async () => Object.keys(history).map((name) => ({ id: `jf-${name}`, name })),
    listSeries: async () => [{ id: "series-1", providerIds: { tvdb: "500" } }],
    listHistory: async (id) => history[id.replace("jf-", "")] ?? [],
  };
  return {
    imported,
    held,
    report: importWatchHistory({
      source,
      library: { listUnitLocations: async () => LOCATIONS },
      users: { getUserByUsername: async (name) => (accounts[name] ? ({ id: accounts[name] } as never) : null) },
      progress: {
        importHistory: async (id, entries) => void (imported[id] = [...entries]),
        holdHistory: async (name, entries) => void (held[name] = [...entries]),
      },
      now: () => NOW,
    }),
  };
}

describe("importWatchHistory", () => {
  it("matches by path even when the servers mount the files differently", async () => {
    const { imported, report } = run(
      { alex: [item({ id: "1", path: "/media/shows/Show/Season 1/Show - S01E01.mkv", played: true })] },
      { alex: "user-alex" },
    );
    expect((await report).users).toEqual([{ username: "alex", outcome: "imported", matched: 1, unmatched: 0 }]);
    expect(imported["user-alex"]).toEqual([
      {
        unitId: "u-s1e1",
        positionSeconds: 1500,
        durationSeconds: 1500,
        completed: true,
        watchedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
  });

  it("falls back to the series' provider id plus season and episode, and to the movie's own id", async () => {
    const { imported, report } = run(
      {
        alex: [
          item({ id: "1", path: "/elsewhere/renamed.mkv", seriesId: "series-1", seasonNumber: 1, episodeNumber: 2, positionSeconds: 600 }),
          item({ id: "2", type: "Movie", path: null, providerIds: { tmdb: "949" }, played: true, runtimeSeconds: 10_000 }),
        ],
      },
      { alex: "user-alex" },
    );
    await report;
    expect(imported["user-alex"]!.map((entry) => [entry.unitId, entry.completed, entry.positionSeconds])).toEqual([
      ["u-s1e2", false, 600],
      ["u-movie", true, 10_000],
    ]);
  });

  it("counts what it can't match, and holds history for people with no account", async () => {
    const { imported, held, report } = run(
      { sam: [item({ id: "1", path: "/x/unknown.mkv" }), item({ id: "2", path: "/x/Show - S01E01.mkv", played: true })] },
      {},
    );
    // The second path shares only its file name with the real one, but that's unique, so it still matches.
    expect((await report).users).toEqual([{ username: "sam", outcome: "held", matched: 1, unmatched: 1 }]);
    expect(imported).toEqual({});
    expect(held.sam!.map((entry) => entry.unitId)).toEqual(["u-s1e1"]);
  });

  it("keeps watched if either of two Jellyfin copies was watched", async () => {
    const path = "/media/shows/Show/Season 1/Show - S01E01.mkv";
    const { imported, report } = run(
      {
        alex: [
          item({ id: "1", path, played: true, lastPlayedAt: new Date("2026-02-01T00:00:00Z") }),
          item({ id: "2", path, positionSeconds: 30, lastPlayedAt: new Date("2026-03-01T00:00:00Z") }),
        ],
      },
      { alex: "user-alex" },
    );
    await report;
    const [entry] = imported["user-alex"]!;
    expect(entry!.watchedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect(entry!.updatedAt).toEqual(new Date("2026-03-01T00:00:00Z"));
  });
});
