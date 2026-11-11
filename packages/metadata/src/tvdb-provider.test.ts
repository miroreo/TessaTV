import { describe, expect, it, vi } from "vitest";
import { TvdbClient } from "./tvdb-client.js";
import { TvdbMetadataProvider } from "./tvdb-provider.js";

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The URL of the nth request the client made. */
function requestedUrl(fetchImpl: { mock: { calls: unknown[][] } }, call: number): URL {
  return new URL((fetchImpl.mock.calls[call]![0] as Request).url);
}

function envelope<T>(data: T) {
  return { status: "success", data };
}

describe("TvdbMetadataProvider", () => {
  it("maps a search response (type=series) into generic candidates", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "jwt" }))) // login
      .mockResolvedValueOnce(
        fakeResponse(
          envelope([
            { tvdb_id: "81189", name: "Breaking Bad", year: "2008", overview: "...", image_url: "https://x/p.jpg" },
          ]),
        ),
      );
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    const candidates = await provider.search({ title: "Breaking Bad", year: 2008, mediaKind: "series" });

    expect(candidates).toEqual([
      { externalId: "81189", title: "Breaking Bad", year: 2008, overview: "...", posterUrl: "https://x/p.jpg" },
    ]);
    const searchUrl = requestedUrl(fetchImpl, 1);
    expect(searchUrl.pathname).toBe("/v4/search");
    expect(searchUrl.searchParams.get("type")).toBe("series");
  });

  it("fetchDetails for a series uses the extended endpoint's overview directly (one call)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "jwt" }))) // login
      .mockResolvedValueOnce(
        fakeResponse(
          envelope({
            id: 81189,
            name: "Breaking Bad",
            year: "2008",
            overview: "When Walter White...",
            image: "https://x/poster.jpg",
            artworks: [
              { type: 2, image: "https://x/other-poster.jpg" },
              { type: 3, image: "https://x/background.jpg" },
            ],
          }),
        ),
      );
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    const details = await provider.fetchDetails("81189", "series");

    expect(details).toEqual({
      externalId: "81189",
      title: "Breaking Bad",
      overview: "When Walter White...",
      year: 2008,
      posterUrl: "https://x/poster.jpg",
      backdropUrl: "https://x/background.jpg",
    });
    // login + one details call — no second request needed for series.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fetchDetails for a movie needs a second call for overview text (extended lacks it)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "jwt" }))) // login
      .mockResolvedValueOnce(
        fakeResponse(
          envelope({
            id: 169,
            name: "The Matrix",
            year: "1999",
            image: "https://x/poster.jpg",
            artworks: [{ type: 15, image: "https://x/background.jpg" }],
          }),
        ),
      )
      .mockResolvedValueOnce(fakeResponse(envelope({ overview: "A hacker discovers..." })));
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    const details = await provider.fetchDetails("169", "movie");

    expect(details).toEqual({
      externalId: "169",
      title: "The Matrix",
      overview: "A hacker discovers...",
      year: 1999,
      posterUrl: "https://x/poster.jpg",
      backdropUrl: "https://x/background.jpg",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const translationsUrl = requestedUrl(fetchImpl, 2);
    expect(translationsUrl.pathname).toBe("/v4/movies/169/translations/eng");
  });

  it("fetchDetails returns null for an unknown id (404) instead of throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "jwt" })))
      .mockResolvedValueOnce(fakeResponse({ status: "failure", message: "not found" }, 404));
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    await expect(provider.fetchDetails("999999", "movie")).resolves.toBeNull();
  });

  it("fetchEpisodes follows every page and skips unnamed or unnumbered episodes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "jwt" })))
      .mockResolvedValueOnce(
        fakeResponse({
          status: "success",
          data: { episodes: [{ name: "Pilot", seasonNumber: 1, number: 1 }, { name: "", seasonNumber: 1, number: 2 }] },
          links: { next: 1 },
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          status: "success",
          data: { episodes: [{ name: " Dead Drop ", seasonNumber: 1, number: 4 }, { name: "Orphan" }] },
          links: { next: null },
        }),
      );
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    const episodes = await provider.fetchEpisodes("247808");

    expect(episodes).toEqual([
      { season: 1, episode: 1, title: "Pilot" },
      { season: 1, episode: 4, title: "Dead Drop" },
    ]);
    expect(requestedUrl(fetchImpl, 1).pathname).toBe("/v4/series/247808/episodes/default/eng");
    expect(requestedUrl(fetchImpl, 1).searchParams.get("page")).toBe("0");
    expect(requestedUrl(fetchImpl, 2).searchParams.get("page")).toBe("1");
  });

  it("fetchEpisodes gives up when the next page never advances, instead of collecting forever", async () => {
    const stuck = () => fakeResponse({ status: "success", data: { episodes: [{ name: "Pilot", seasonNumber: 1, number: 1 }] }, links: { next: 0 } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeResponse(envelope({ token: "jwt" }))).mockImplementation(async () => stuck());
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    await expect(provider.fetchEpisodes("247808")).rejects.toThrow(/didn't advance/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fetchEpisodes returns an empty list for an unknown series (404)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "jwt" })))
      .mockResolvedValueOnce(fakeResponse({ status: "failure" }, 404));
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    expect(await provider.fetchEpisodes("0")).toEqual([]);
  });

  it("re-logs in exactly once when a request comes back 401, then retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "stale-jwt" }))) // initial login
      .mockResolvedValueOnce(fakeResponse({}, 401)) // request rejected with stale token
      .mockResolvedValueOnce(fakeResponse(envelope({ token: "fresh-jwt" }))) // re-login
      .mockResolvedValueOnce(fakeResponse(envelope({ id: 169, name: "The Matrix", year: "1999" }))); // retried request
    const provider = new TvdbMetadataProvider(new TvdbClient({ apiKey: "key", fetchImpl }));

    const details = await provider.fetchDetails("169", "series");

    expect(details?.title).toBe("The Matrix");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
