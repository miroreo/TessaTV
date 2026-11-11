import { describe, expect, it, vi } from "vitest";
import { AuthFailedError, QuotaExhaustedError, RateLimitedError } from "./errors.js";
import { OpenSubtitlesProvider } from "./opensubtitles.js";
import type { SubtitleCandidate, SubtitleQuery } from "./subtitle-provider.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function provider(fetchImpl: typeof fetch) {
  return new OpenSubtitlesProvider({ apiKey: "key", username: "u", password: "p", userAgent: "TessaTV v0", fetchImpl });
}

const episode: SubtitleQuery = {
  kind: "episode", languages: ["pt-BR", "en"], externalIds: { tmdb: "1396", imdb: "tt0903747" },
  title: "Show", year: null, season: 1, episode: 2, movieHash: "abcdef0123456789", fileName: "Show.S01E02.mkv",
};

const searchBody = {
  data: [
    {
      id: "10",
      attributes: {
        language: "pt-BR", download_count: 500, hearing_impaired: true, foreign_parts_only: false, release: "Show.S01E02.WEB-DL-GRP",
        upload_date: "2024-05-01T00:00:00Z", moviehash_match: true, feature_details: { season_number: 1, episode_number: 2 },
        files: [{ file_id: 777, file_name: "Show.S01E02.srt" }],
      },
    },
    { id: "11", attributes: { language: "xx", files: [{ file_id: 1 }] } },
    { id: "12", attributes: { language: "en", files: [] } },
  ],
};

describe("OpenSubtitlesProvider", () => {
  it("sends sorted, lowercase parameters and the identifying headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [] }));
    await provider(fetchImpl).search(episode);
    const request = fetchImpl.mock.calls[0]![0] as Request;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/v1/subtitles");
    expect([...url.searchParams.keys()]).toEqual([...url.searchParams.keys()].sort());
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      languages: "en,pt-br", moviehash: "abcdef0123456789", parent_tmdb_id: "1396", parent_imdb_id: "0903747", season_number: "1", episode_number: "2",
      ai_translated: "exclude", machine_translated: "exclude", foreign_parts_only: "exclude",
    });
    expect(url.searchParams.has("query")).toBe(false);
    expect(request.headers.get("api-key")).toBe("key");
    expect(request.headers.get("user-agent")).toBe("TessaTV v0");
  });

  it("falls back to a title query when it has nothing else to search by", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [] }));
    await provider(fetchImpl).search({ kind: "movie", languages: ["en"], externalIds: {}, title: "Movie", year: 2020, fileName: "Movie.mkv" });
    const url = new URL((fetchImpl.mock.calls[0]![0] as Request).url);
    expect(url.searchParams.get("query")).toBe("Movie");
    expect(url.searchParams.get("year")).toBe("2020");
  });

  it("maps results to candidates and skips ones it can't use", async () => {
    const candidates = await provider(vi.fn().mockResolvedValue(json(searchBody))).search(episode);
    expect(candidates).toEqual([
      {
        provider: "opensubtitles", providerId: "777", language: "pt-BR", format: "srt", forced: false, hearingImpaired: true,
        aiTranslated: false, machineTranslated: false, releaseName: "Show.S01E02.WEB-DL-GRP", matchedBy: ["hash"], season: 1, episode: 2,
        downloadCount: 500, uploadedAt: new Date("2024-05-01T00:00:00Z"),
      },
    ]);
  });

  it("logs in, asks for the download link, then fetches the file without credentials", async () => {
    let downloadBody: unknown;
    const fetchImpl = vi.fn(async (input: Request | string | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/login")) return json({ token: "jwt" });
      if (url.pathname.endsWith("/download")) {
        downloadBody = await (input as Request).clone().json();
        return json({ link: "https://dl.example/file.srt", file_name: "x.srt" });
      }
      return new Response("1\n00:00:01,000 --> 00:00:02,000\nHi\n");
    });
    const download = await provider(fetchImpl as unknown as typeof fetch).download({ providerId: "777", format: "srt" } as SubtitleCandidate);
    expect(download.fileName).toBe("x.srt");
    expect(new TextDecoder().decode(download.bytes)).toContain("Hi");
    const calls = fetchImpl.mock.calls.map(([input]) => input as Request);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer jwt");
    expect(downloadBody).toEqual({ file_id: 777 });
    expect(calls[2]!.headers.get("authorization")).toBeNull();
    expect(calls[2]!.headers.get("api-key")).toBeNull();
  });

  it("turns HTTP failures into provider errors", async () => {
    const cases: [Response, unknown][] = [
      [json({}, 401), AuthFailedError],
      [json({}, 429, { "retry-after": "12" }), RateLimitedError],
    ];
    for (const [response, errorClass] of cases) {
      await expect(provider(vi.fn().mockResolvedValue(response)).search(episode)).rejects.toBeInstanceOf(errorClass as typeof Error);
    }
    const limited = await provider(vi.fn().mockResolvedValue(json({}, 429, { "retry-after": "12" }))).search(episode).catch((e) => e);
    expect(limited.retryAfterSeconds).toBe(12);

    const fetchImpl = vi.fn(async (input: Request | string | URL) =>
      new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/login") ? json({ token: "t" }) : json({}, 406),
    );
    await expect(provider(fetchImpl as unknown as typeof fetch).download({ providerId: "1", format: "srt" } as SubtitleCandidate)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });
});
