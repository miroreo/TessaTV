import { describe, expect, it, vi } from "vitest";
import { TvdbClient } from "./tvdb-client.js";
import { TvdbMetadataProvider } from "./tvdb-provider.js";

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status === 401 ? "Unauthorized" : "OK",
    json: async () => body,
  } as Response;
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
    const searchUrl = fetchImpl.mock.calls[1]![0] as URL;
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
    const translationsUrl = fetchImpl.mock.calls[2]![0] as URL;
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
