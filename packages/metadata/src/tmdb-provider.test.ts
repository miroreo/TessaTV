import { describe, expect, it, vi } from "vitest";
import { TmdbClient } from "./tmdb-client.js";
import { TmdbMetadataProvider } from "./tmdb-provider.js";

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The URL of the nth request the client made. */
function requestedUrl(fetchImpl: { mock: { calls: unknown[][] } }, call: number): URL {
  return new URL((fetchImpl.mock.calls[call]![0] as Request).url);
}

describe("TmdbMetadataProvider", () => {
  it("maps a movie search response into generic candidates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse({
        results: [
          { id: 603, title: "The Matrix", release_date: "1999-03-30", overview: "...", poster_path: "/matrix.jpg" },
        ],
      }),
    );
    const provider = new TmdbMetadataProvider(new TmdbClient({ apiKey: "key", fetchImpl }));

    const candidates = await provider.search({ title: "The Matrix", year: 1999, mediaKind: "movie" });

    expect(candidates).toEqual([
      {
        externalId: "603",
        title: "The Matrix",
        year: 1999,
        overview: "...",
        posterUrl: "https://image.tmdb.org/t/p/w500/matrix.jpg",
      },
    ]);
    const url = requestedUrl(fetchImpl, 0);
    expect(url.pathname).toBe("/3/search/movie");
    expect(url.searchParams.get("query")).toBe("The Matrix");
    expect(url.searchParams.get("year")).toBe("1999");
    expect(url.searchParams.get("api_key")).toBe("key");
  });

  it("maps a TV search response, using first_air_date_year instead of year", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse({
        results: [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: null }],
      }),
    );
    const provider = new TmdbMetadataProvider(new TmdbClient({ apiKey: "key", fetchImpl }));

    const candidates = await provider.search({ title: "Breaking Bad", year: 2008, mediaKind: "series" });

    expect(candidates).toEqual([
      { externalId: "1396", title: "Breaking Bad", year: 2008, overview: null, posterUrl: null },
    ]);
    const url = requestedUrl(fetchImpl, 0);
    expect(url.pathname).toBe("/3/search/tv");
    expect(url.searchParams.get("first_air_date_year")).toBe("2008");
  });

  it("fetchDetails returns null for an unknown id (404) instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({}, 404));
    const provider = new TmdbMetadataProvider(new TmdbClient({ apiKey: "key", fetchImpl }));

    await expect(provider.fetchDetails("999999", "movie")).resolves.toBeNull();
  });

  it("fetchDetails maps movie details including backdrop", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse({
        id: 603,
        title: "The Matrix",
        overview: "A hacker...",
        release_date: "1999-03-30",
        poster_path: "/p.jpg",
        backdrop_path: "/b.jpg",
      }),
    );
    const provider = new TmdbMetadataProvider(new TmdbClient({ apiKey: "key", fetchImpl }));

    const details = await provider.fetchDetails("603", "movie");

    expect(details).toEqual({
      externalId: "603",
      title: "The Matrix",
      overview: "A hacker...",
      year: 1999,
      posterUrl: "https://image.tmdb.org/t/p/w500/p.jpg",
      backdropUrl: "https://image.tmdb.org/t/p/w500/b.jpg",
    });
  });
});
