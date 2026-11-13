import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "@tessatv/auth";
import type {
  AuthSession,
  AuthSessionRepository,
  FileHealth,
  FileHealthRepository,
  LibraryNode,
  LibraryRepository,
  MediaFile,
  ServerSettings,
  ServerSettingsRepository,
  SubtitleFile,
  SubtitleRepository,
  Unit,
  User,
  UserRepository,
  WatchProgress,
  WatchProgressRepository,
} from "@tessatv/domain";
import { type MediaProbe, SoftwareAccel, TranscodeManager, type TranscodeSession } from "@tessatv/streaming";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

class InMemoryUsers implements UserRepository {
  private readonly users: User[] = [];
  async countUsers() {
    return this.users.length;
  }
  async getUserByOidcSubject(subject: string) {
    return this.users.find((user) => user.oidcSubject === subject) ?? null;
  }
  async listUsers() {
    return [...this.users];
  }
  async updateOidcLogin(id: string, changes: { oidcSubject: string; isAdmin: boolean; updatedAt: Date }) {
    const index = this.users.findIndex((user) => user.id === id);
    if (index >= 0) this.users[index] = { ...this.users[index]!, ...changes };
  }
  async getUser(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }
  async getUserByUsername(username: string) {
    return this.users.find((user) => user.username === username) ?? null;
  }
  async createFirstUser(user: User) {
    this.users.push(user);
    return true;
  }
  async createUser(user: User) {
    this.users.push(user);
  }
  async updatePasswordHash() {}
}

class InMemorySessions implements AuthSessionRepository {
  private readonly sessions: AuthSession[] = [];
  async createSession(session: AuthSession) {
    this.sessions.push(session);
  }
  async getSessionByTokenHash(tokenHash: string) {
    return this.sessions.find((session) => session.tokenHash === tokenHash) ?? null;
  }
  async touchSession() {}
  async deleteSession() {}
}

class InMemoryProgress implements WatchProgressRepository {
  async markWatched(userId: string, unitIds: readonly string[], at: Date) {
    unitIds.forEach((unitId, order) => {
      const when = new Date(at.getTime() + order);
      const existing = this.rows.find((row) => row.userId === userId && row.unitId === unitId);
      const watchedAt = existing?.watchedAt && existing.watchedAt > when ? existing.watchedAt : when;
      this.rows = [
        ...this.rows.filter((row) => !(row.userId === userId && row.unitId === unitId)),
        {
          userId,
          unitId,
          positionSeconds: existing?.durationSeconds ?? existing?.positionSeconds ?? 0,
          durationSeconds: existing?.durationSeconds ?? null,
          completed: true,
          watchedAt,
          updatedAt: when,
        },
      ];
    });
  }
  async markUnwatched(userId: string, unitIds: readonly string[]) {
    this.rows = this.rows.map((row) =>
      row.userId === userId && unitIds.includes(row.unitId) ? { ...row, positionSeconds: 0, completed: false, watchedAt: null } : row,
    );
  }
  async importHistory() {}
  async holdHistory() {}
  async claimHeldHistory() {
    return 0;
  }
  async forgetPosition(userId: string, unitId: string) {
    this.rows = this.rows.map((row) =>
      row.userId === userId && row.unitId === unitId ? { ...row, positionSeconds: 0, completed: false } : row,
    );
  }
  rows: WatchProgress[] = [];
  async get(userId: string, unitId: string) {
    return this.rows.find((row) => row.userId === userId && row.unitId === unitId) ?? null;
  }
  async save(progress: WatchProgress) {
    // Like the real repository, a save never clears or rewinds watchedAt.
    const previous = (await this.get(progress.userId, progress.unitId))?.watchedAt ?? null;
    const watchedAt = previous && (!progress.watchedAt || previous > progress.watchedAt) ? previous : progress.watchedAt;
    this.rows = [...this.rows.filter((row) => row.unitId !== progress.unitId), { ...progress, watchedAt }];
  }
  async listRecent(userId: string) {
    return this.rows.filter((row) => row.userId === userId).reverse();
  }
  async listForUnits(userId: string, unitIds: readonly string[]) {
    return this.rows.filter((row) => row.userId === userId && unitIds.includes(row.unitId));
  }
}

class InMemorySettings implements ServerSettingsRepository {
  settings: ServerSettings = { maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false };
  async get() {
    return this.settings;
  }
  async update(changes: Partial<ServerSettings>) {
    this.settings = { ...this.settings, ...changes };
    return this.settings;
  }
}

/** Reports the files in `damaged` (major) and `minor` as the background decode check would have found them. */
class FakeFileHealth implements FileHealthRepository {
  readonly damaged = new Set<string>();
  readonly minor = new Set<string>();
  async get(mediaFileId: string): Promise<FileHealth | null> {
    const severity = this.damaged.has(mediaFileId) ? "major" : this.minor.has(mediaFileId) ? "minor" : null;
    return severity
      ? { mediaFileId, checkedAt: new Date(5000), sizeBytes: 26, error: "error while decoding MB 3 13", severity, videoErrors: 1, audioErrors: 0 }
      : null;
  }
  async save() {}
  async summary() {
    return { total: 4, clean: 1, minor: 1, major: 1, due: 1 };
  }
  async listFlagged() {
    return [
      { mediaFileId: "file-film", path: "/media/film.mp4", error: "error while decoding MB 3 13", severity: "major" as const, videoErrors: 30, audioErrors: 0, checkedAt: new Date(5000) },
      { mediaFileId: "file-show", path: "/media/show.mkv", error: "[ac3 @ 0x1] error decoding the audio block", severity: "minor" as const, videoErrors: 0, audioErrors: 2, checkedAt: new Date(6000) },
    ];
  }
  async listDue() {
    return [];
  }
}

const NOW = new Date(0);

/** Only what playback reads: the files recorded for a unit. */
class FakeSubtitles {
  constructor(private readonly files: SubtitleFile[]) {}
  async listForUnit(unitId: string) {
    return this.files.filter((file) => file.unitId === unitId);
  }
  async get(id: string) {
    return this.files.find((file) => file.id === id) ?? null;
  }
}

const node = (id: string, kind: LibraryNode["kind"], parentId: string | null, mediaType: string): LibraryNode => ({
  id, kind, parentId, mediaType, title: id, sortTitle: id, sourceKey: id, externalIds: [],
  monitored: true, qualityProfileId: null, createdAt: NOW, updatedAt: NOW,
});
const unit = (id: string, libraryNodeId: string, path: number[]): Unit => ({
  id, libraryNodeId, mediaType: "series", title: `Title ${id}`, sequence: { path }, externalIds: [],
  availability: "available", mediaFileId: `file-${id}`, createdAt: NOW, updatedAt: NOW,
});

class Library implements LibraryRepository {
  constructor(
    private readonly nodes: LibraryNode[],
    private readonly units: Unit[],
    private readonly files: MediaFile[],
  ) {}
  async getNode(id: string) {
    return this.nodes.find((entry) => entry.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((entry) => entry.parentId === parentId);
  }
  async createNode() {}
  async updateNode() {}
  async deleteNode() {}
  async getUnit(id: string) {
    return this.units.find((entry) => entry.id === id) ?? null;
  }
  async listUnits(libraryNodeId: string) {
    return this.units.filter((entry) => entry.libraryNodeId === libraryNodeId);
  }
  async createUnit() {}
  async updateUnit() {}
  async listUnitLocations() {
    return [];
  }
  async moveWatchProgress() {}
  async getMediaFile(id: string) {
    return this.files.find((entry) => entry.id === id) ?? null;
  }
  async createMediaFile() {}
}

const probeOf = (path: string, container: string): MediaProbe => ({
  path, container, durationSeconds: 1000, bitRate: 2_000_000, sizeBytes: 100,
  videoStreams: [{ index: 0, codec: "h264", language: null, title: null, isDefault: true, profile: "High", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8, frameRate: 24, bitRate: null, isHdr: false }],
  audioStreams: [{ index: 1, codec: "aac", language: "eng", title: null, isDefault: true, profile: "LC", channels: 2, channelLayout: "stereo", sampleRate: 48000, bitRate: null }],
  subtitleStreams: [{ index: 2, codec: "subrip", language: "eng", title: null, isDefault: false, isForced: false, isTextBased: true }],
});

const CAPABILITIES = {
  directPlayContainers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  hls: { segmentContainers: ["fmp4"], videoCodecs: ["h264"], audioCodecs: ["aac"], maxAudioChannels: 2 },
};

describe("browse, playback and progress routes", () => {
  let root: string;
  let app: ReturnType<typeof buildApp>;
  let headers: { authorization: string };
  const extractCalls: { index: number; charset: string | undefined }[] = [];
  const progress = new InMemoryProgress();
  const settings = new InMemorySettings();
  const fileHealth = new FakeFileHealth();
  const transcodeDir = () => join(root, "hls");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tessatv-playback-test-"));
    const files: MediaFile[] = ["e1", "e2", "film"].map((id) => ({
      id: `file-${id}`, unitId: id, path: join(root, `${id}.${id === "film" ? "mp4" : "mkv"}`),
      container: id === "film" ? "mp4" : "mkv", videoCodec: "h264", audioCodec: "aac", resolutionWidth: 1280,
      resolutionHeight: 720, sizeBytes: 26, checksum: null, importedAt: NOW,
    }));
    for (const file of files) await writeFile(file.path, "abcdefghijklmnopqrstuvwxyz");
    await writeFile(join(root, "film.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    await writeFile(join(root, "film.fr.srt"), Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x20, 0x61, 0x75, 0x20, 0x6c, 0x61, 0x69, 0x74, 0x20, 0x65, 0x74, 0x20, 0x6a, 0x27, 0x61, 0x69, 0x6d, 0x65, 0x20, 0x6c, 0xe0, 0x20, 0xe9, 0xe8, 0xea]));
    const subtitleFile = (id: string, unitId: string, language: string, path: string, forced = false): SubtitleFile => ({
      id, unitId, mediaFileId: `file-${unitId}`, language, forced, hearingImpaired: false, source: "downloaded", provider: null,
      providerId: null, score: null, path, format: "srt", createdAt: NOW,
    });
    const library = new Library(
      [node("show", "collection", null, "series"), node("s1", "collection", "show", "series"), node("l1", "leaf", "s1", "series"), node("l2", "leaf", "s1", "series"), node("movie", "leaf", null, "movie")],
      [unit("e2", "l2", [1, 2]), unit("e1", "l1", [1, 1]), { ...unit("film", "movie", []), mediaType: "movie" }],
      files,
    );
    const fakeSession = (directory: string, fails = false) =>
      ({ id: `session-${Math.random()}`, outputDirectory: directory, state: "running", progress: { outTimeSeconds: 0, speed: 1 },
        result: null,
        waitForPlaylist: async () => {
          if (fails) throw new Error("Transcode failed before producing a playlist: Invalid data found");
          return join(directory, "index.m3u8");
        },
        dispose: async () => {} }) as unknown as TranscodeSession;
    const transcodes = new TranscodeManager({
      directory: transcodeDir(),
      accel: new SoftwareAccel(),
      // The fake sessions never finish, so each test's transcodes stay "running".
      maxConcurrent: 10,
      startSession: async (plan, options) => {
        await writeFile(join(root, "playlist.m3u8"), "#EXTM3U\n");
        // e2 stands in for a damaged file: only the error-tolerant levels get through it.
        return fakeSession(options.directory, plan.path.endsWith("e2.mkv") && plan.fallbackLevel < 2);
      },
    });
    const auth = new AuthService(new InMemoryUsers(), new InMemorySessions());
    const { token } = await auth.completeSetup("viewer", "a-long-enough-password", null);
    headers = { authorization: `Bearer ${token}` };
    app = buildApp({
      settings,
      fileHealth: { repository: fileHealth, status: () => ({ state: "checking", fullSpeed: false, current: { path: "/media/e1.mkv", startedAt: new Date(7000), durationSeconds: 600, positionSeconds: 150, fps: 96, speed: 4 } }) },
      libraryRepository: library,
      metadataProviders: {},
      auth,
      playback: {
        progressRepository: progress,
        metadataCache: null,
        transcodes,
        fileHealthRepository: fileHealth,
        probe: async (path) => probeOf(path, path.endsWith(".mp4") ? "mp4" : "mkv"),
        subtitleRepository: new FakeSubtitles([
          subtitleFile("sub-fr", "film", "fr", join(root, "film.fr.srt")),
          subtitleFile("sub-en", "film", "en", join(root, "film.en.srt")),
          subtitleFile("sub-gone", "e1", "en", join(root, "missing.en.srt")),
        ]) as unknown as SubtitleRepository,
        extractSubtitles: async (_path, index, charset) => {
          extractCalls.push({ index, charset });
          return "WEBVTT\n\n00:01:40.000 --> 00:01:45.000\nHi\n";
        },
      },
    });
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/browse/home" })).statusCode).toBe(401);
  });

  it("splits the home view into movies and shows", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/browse/home", headers })).json();
    expect(body.movies.map((title: { id: string }) => title.id)).toEqual(["movie"]);
    expect(body.shows.map((title: { id: string }) => title.id)).toEqual(["show"]);
  });

  it("direct-plays a compatible file and serves byte ranges of it", async () => {
    const started = await app.inject({ method: "POST", url: "/api/playback/film/start", headers, payload: { capabilities: CAPABILITIES } });
    expect(started.json()).toMatchObject({ mode: "direct-play", url: "/api/playback/film/file", transcodeId: null });
    const ranged = await app.inject({ method: "GET", url: "/api/playback/film/file", headers: { ...headers, range: "bytes=2-4" } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe("bytes 2-4/26");
    expect(ranged.body).toBe("cde");
    const beyond = await app.inject({ method: "GET", url: "/api/playback/film/file", headers: { ...headers, range: "bytes=99-" } });
    expect(beyond.statusCode).toBe(416);
  });

  it("lists subtitle files beside the video after the embedded tracks, in a stable order", async () => {
    const info = (await app.inject({ method: "GET", url: "/api/playback/film", headers })).json();
    expect(info.subtitleStreams.slice(1)).toEqual([
      { index: 10000, label: "EN · SRT file", language: "eng", isDefault: false, isForced: false, isTextBased: true, isExternal: true },
      { index: 10001, label: "FR · SRT file", language: "fra", isDefault: false, isForced: false, isTextBased: true, isExternal: true },
    ]);
  });

  it("plays a subtitle file without touching how the video is delivered, and serves it as WebVTT", async () => {
    const started = await app.inject({ method: "POST", url: "/api/playback/film/start", headers, payload: { capabilities: CAPABILITIES, subtitleStreamIndex: 10000 } });
    expect(started.json()).toMatchObject({ mode: "direct-play", url: "/api/playback/film/file", subtitleUrl: "/api/playback/film/subtitles/external/sub-en.vtt" });
    const vtt = await app.inject({ method: "GET", url: "/api/playback/film/subtitles/external/sub-en.vtt", headers });
    expect(vtt.statusCode).toBe(200);
    expect(vtt.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    expect(vtt.body).toContain("WEBVTT");
    expect(extractCalls.at(-1)).toEqual({ index: 0, charset: undefined });
  });

  it("tells ffmpeg the encoding of a subtitle file that isn't UTF-8", async () => {
    await app.inject({ method: "GET", url: "/api/playback/film/subtitles/external/sub-fr.vtt", headers });
    expect(extractCalls.at(-1)?.index).toBe(0);
    expect(extractCalls.at(-1)?.charset).toMatch(/1252|8859/i);
  });

  it("keeps the chosen subtitle file through a seek, and ignores an index that doesn't exist", async () => {
    const started = (await app.inject({ method: "POST", url: "/api/playback/e1/start", headers, payload: { capabilities: CAPABILITIES } })).json();
    expect(started.subtitleUrl).toBeNull();
    // e1 has only an unreadable file recorded, which the info lists but can't be served.
    const withFile = (await app.inject({ method: "POST", url: "/api/playback/e1/start", headers, payload: { capabilities: CAPABILITIES, subtitleStreamIndex: 10000 } })).json();
    expect(withFile.subtitleUrl).toBe("/api/playback/e1/subtitles/external/sub-gone.vtt");
    const seeked = (await app.inject({ method: "POST", url: "/api/playback/e1/seek", headers, payload: { transcodeId: withFile.transcodeId, seconds: 300 } })).json();
    expect(seeked.subtitleUrl).toBe("/api/playback/e1/subtitles/external/sub-gone.vtt");
    const missing = (await app.inject({ method: "POST", url: "/api/playback/e1/start", headers, payload: { capabilities: CAPABILITIES, subtitleStreamIndex: 10005 } })).json();
    expect(missing.subtitleUrl).toBeNull();
  });

  it("won't serve a subtitle file for another unit, or one that's gone from disk", async () => {
    expect((await app.inject({ method: "GET", url: "/api/playback/e1/subtitles/external/sub-en.vtt", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/playback/e1/subtitles/external/sub-gone.vtt", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/playback/film/subtitles/external/nope.vtt", headers })).statusCode).toBe(404);
  });

  it("starts an HLS transcode for an unsupported container, with a sidecar subtitle offset to its start", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/playback/e1/start",
      headers,
      payload: { capabilities: CAPABILITIES, startSeconds: 90, subtitleStreamIndex: 2 },
    });
    const body = started.json();
    expect(body).toMatchObject({ mode: "remux", startTimeSeconds: 90, subtitleUrl: "/api/playback/e1/subtitles/2.vtt" });
    expect(body.url).toMatch(/^\/api\/transcodes\/[\w-]+\/session-[\d.]+\/index\.m3u8$/);
    const vtt = await app.inject({ method: "GET", url: body.subtitleUrl, headers });
    expect(vtt.headers["content-type"]).toMatch(/^text\/vtt/);
    expect(vtt.body).toContain("00:01:40.000 --> 00:01:45.000");
  });

  it("steps down fallback levels until a stream starts, and starts at a level the client asks for", async () => {
    const started = await app.inject({ method: "POST", url: "/api/playback/e2/start", headers, payload: { capabilities: CAPABILITIES } });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ mode: "transcode", fallbackLevel: 2, hasVideo: true });

    // A client that couldn't decode the direct-play file asks for level 1.
    const fallback = await app.inject({
      method: "POST",
      url: "/api/playback/film/start",
      headers,
      payload: { capabilities: CAPABILITIES, fallbackLevel: 1 },
    });
    expect(fallback.json()).toMatchObject({ mode: "transcode", fallbackLevel: 1 });
    const outOfRange = { capabilities: CAPABILITIES, fallbackLevel: 4 };
    expect((await app.inject({ method: "POST", url: "/api/playback/film/start", headers, payload: outOfRange })).statusCode).toBe(400);
  });

  it("gives admins the server's side of stream stats, including what's encoding on what", async () => {
    const { transcodeId } = (
      await app.inject({ method: "POST", url: "/api/playback/e2/start", headers, payload: { capabilities: CAPABILITIES } })
    ).json();
    const stats = await app.inject({ method: "GET", url: `/api/playback/e2/stats?transcodeId=${transcodeId}`, headers });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toMatchObject({
      file: { container: "mkv", bitRate: 2_000_000 },
      sourceVideo: { codec: "h264", width: 1280, height: 720 },
      sourceAudio: { codec: "aac", channels: 2 },
      transcode: {
        mode: "transcode",
        fallbackLevel: 2,
        video: { action: "transcode", codec: "h264" },
        encoder: { decode: "cpu", encode: "cpu", accel: "none", encodeDevice: expect.any(String) },
        state: "running",
        speed: 1,
      },
    });
    const directPlay = (await app.inject({ method: "GET", url: "/api/playback/film/stats", headers })).json();
    expect(directPlay.transcode).toBeNull();
  });

  it("caps every stream at the admin's maximum resolution, transcoding a file that would direct play", async () => {
    const patched = await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { maxStreamHeight: 480 } });
    expect(patched.json()).toEqual({ maxStreamHeight: 480, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false });
    try {
      const started = await app.inject({ method: "POST", url: "/api/playback/film/start", headers, payload: { capabilities: CAPABILITIES } });
      expect(started.json()).toMatchObject({ mode: "transcode", reasons: ["VideoResolutionNotSupported"] });
      const { transcode } = (
        await app.inject({ method: "GET", url: `/api/playback/film/stats?transcodeId=${started.json().transcodeId}`, headers })
      ).json();
      expect(transcode.video).toMatchObject({ action: "transcode", width: 854, height: 480 });
    } finally {
      await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { maxStreamHeight: null } });
    }
    expect((await app.inject({ method: "GET", url: "/api/settings", headers })).json()).toEqual({ maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false });
    expect((await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { maxStreamHeight: 999 } })).statusCode).toBe(400);
    const started = await app.inject({ method: "POST", url: "/api/playback/film/start", headers, payload: { capabilities: CAPABILITIES } });
    expect(started.json()).toMatchObject({ mode: "direct-play" });
  });

  it("starts a file the decode check found damaged on the CPU-only level, until the check is turned off", async () => {
    const start = () => app.inject({ method: "POST", url: "/api/playback/film/start", headers, payload: { capabilities: CAPABILITIES } });
    fileHealth.damaged.add("file-film");
    try {
      expect((await start()).json()).toMatchObject({ mode: "transcode", fallbackLevel: 2 });
      expect((await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { fileHealthCheck: false } })).json()).toMatchObject({ fileHealthCheck: false });
      expect((await start()).json()).toMatchObject({ mode: "direct-play" });
    } finally {
      fileHealth.damaged.clear();
      await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { fileHealthCheck: true } });
    }
  });

  it("leaves a file the decode check graded minor on its normal playback path", async () => {
    fileHealth.minor.add("file-film");
    try {
      const started = await app.inject({ method: "POST", url: "/api/playback/film/start", headers, payload: { capabilities: CAPABILITIES } });
      expect(started.json()).toMatchObject({ mode: "direct-play" });
    } finally {
      fileHealth.minor.clear();
    }
  });

  it("shows the decode check's progress and findings to admins", async () => {
    const status = (await app.inject({ method: "GET", url: "/api/file-health", headers })).json();
    expect(status).toEqual({
      enabled: true,
      fullSpeed: false,
      state: "checking",
      current: { path: "/media/e1.mkv", startedAt: new Date(7000).toISOString(), durationSeconds: 600, positionSeconds: 150, fps: 96, speed: 4 },
      total: 4, clean: 1, minor: 1, major: 1, due: 1,
      flaggedFiles: [
        { path: "/media/film.mp4", error: "error while decoding MB 3 13", severity: "major", videoErrors: 30, audioErrors: 0, checkedAt: new Date(5000).toISOString() },
        { path: "/media/show.mkv", error: "[ac3 @ 0x1] error decoding the audio block", severity: "minor", videoErrors: 0, audioErrors: 2, checkedAt: new Date(6000).toISOString() },
      ],
    });
    await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { fileHealthCheck: false } });
    try {
      expect((await app.inject({ method: "GET", url: "/api/file-health", headers })).json()).toMatchObject({ enabled: false, state: "disabled", current: null });
    } finally {
      await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { fileHealthCheck: true } });
    }
    await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { fileHealthFullSpeed: true } });
    try {
      expect((await app.inject({ method: "GET", url: "/api/file-health", headers })).json()).toMatchObject({ fullSpeed: true });
    } finally {
      await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { fileHealthFullSpeed: false } });
    }
    expect((await app.inject({ method: "GET", url: "/api/file-health" })).statusCode).toBe(401);
  });

  it("marks episodes watched and unwatched by hand, and forgets a saved position", async () => {
    const watch = (unitIds: string[], watched: boolean) =>
      app.inject({ method: "POST", url: "/api/progress/watched", headers, payload: { unitIds, watched } });
    const episode = async (id: string) =>
      (await app.inject({ method: "GET", url: "/api/browse/title/show", headers })).json().units.find((entry: { id: string }) => entry.id === id);

    expect((await watch(["e1", "e2"], true)).statusCode).toBe(204);
    expect((await episode("e2")).progress).toMatchObject({ completed: true, watched: true });
    // Marking the season watched moves "play" past it: nothing after e2.
    expect((await app.inject({ method: "GET", url: "/api/browse/title/show", headers })).json().next).toBeNull();

    expect((await watch(["e2"], false)).statusCode).toBe(204);
    expect((await episode("e2")).progress).toMatchObject({ completed: false, watched: false, positionSeconds: 0 });
    expect((await episode("e1")).progress).toMatchObject({ watched: true });

    await app.inject({ method: "POST", url: "/api/progress/e2", headers, payload: { positionSeconds: 600, durationSeconds: 1000 } });
    expect((await app.inject({ method: "GET", url: "/api/browse/home", headers })).json().continueWatching.map((entry: { unit: { id: string } }) => entry.unit.id)).toContain("e2");
    expect((await app.inject({ method: "DELETE", url: "/api/progress/e2/position", headers })).statusCode).toBe(204);
    expect((await episode("e2")).progress).toMatchObject({ positionSeconds: 0, completed: false });
    expect((await app.inject({ method: "GET", url: "/api/browse/home", headers })).json().continueWatching.map((entry: { unit: { id: string } }) => entry.unit.id)).not.toContain("e2");

    expect((await watch(["nope"], true)).statusCode).toBe(404);
  });

  it("rejects missing capabilities and refuses to serve arbitrary transcode files", async () => {
    expect((await app.inject({ method: "POST", url: "/api/playback/e1/start", headers, payload: {} })).statusCode).toBe(400);
    const badCodec = { ...CAPABILITIES, hls: { ...CAPABILITIES.hls, videoCodecs: ["mpeg2"] } };
    expect((await app.inject({ method: "POST", url: "/api/playback/e1/start", headers, payload: { capabilities: badCodec } })).statusCode).toBe(400);
    const started = (
      await app.inject({ method: "POST", url: "/api/playback/e1/start", headers, payload: { capabilities: CAPABILITIES } })
    ).json();
    const base = started.url.slice(0, started.url.lastIndexOf("/"));
    expect((await app.inject({ method: "GET", url: `${base}/..%2F..%2Fsecret.m3u8`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/transcodes/${started.transcodeId}/stale/index.m3u8`, headers })).statusCode).toBe(410);
  });

  it("records progress, marks completion near the end, and moves next-up along", async () => {
    await app.inject({ method: "POST", url: "/api/progress/e1", headers, payload: { positionSeconds: 300, durationSeconds: 1000 } });
    let home = (await app.inject({ method: "GET", url: "/api/browse/home", headers })).json();
    expect(home.continueWatching.map((entry: { unit: { id: string } }) => entry.unit.id)).toEqual(["e1"]);

    await app.inject({ method: "POST", url: "/api/progress/e1", headers, payload: { positionSeconds: 950, durationSeconds: 1000 } });
    home = (await app.inject({ method: "GET", url: "/api/browse/home", headers })).json();
    expect(home.continueWatching).toEqual([]);
    expect(home.nextUp.map((entry: { unit: { id: string } }) => entry.unit.id)).toEqual(["e2"]);

    const title = (await app.inject({ method: "GET", url: "/api/browse/title/show", headers })).json();
    expect(title.next.id).toBe("e2");
    expect(title.seasons).toMatchObject([{ number: 1, episodes: [{ id: "e1", progress: { completed: true, watched: true } }, { id: "e2" }] }]);
    expect((await app.inject({ method: "POST", url: "/api/progress/e1", headers, payload: { positionSeconds: -1 } })).statusCode).toBe(400);
  });

  it("keeps an episode watched while it's rewatched, resuming the rewatch", async () => {
    await app.inject({ method: "POST", url: "/api/progress/e1", headers, payload: { positionSeconds: 1000, durationSeconds: 1000, ended: true } });
    await app.inject({ method: "POST", url: "/api/progress/e1", headers, payload: { positionSeconds: 120, durationSeconds: 1000 } });

    const title = (await app.inject({ method: "GET", url: "/api/browse/title/show", headers })).json();
    expect(title.seasons[0].episodes[0]).toMatchObject({
      id: "e1",
      progress: { positionSeconds: 120, completed: false, watched: true },
    });
    const home = (await app.inject({ method: "GET", url: "/api/browse/home", headers })).json();
    expect(home.continueWatching.map((entry: { unit: { id: string } }) => entry.unit.id)).toEqual(["e1"]);
  });

  it("describes a unit's tracks and what plays after it", async () => {
    const info = (await app.inject({ method: "GET", url: "/api/playback/e1", headers })).json();
    expect(info).toMatchObject({ durationSeconds: 1000, next: { id: "e2" }, title: { id: "show" }, normalization: null });
    expect(info.subtitleStreams).toEqual([
      { index: 2, label: "ENG · SUBRIP", language: "eng", isDefault: false, isForced: false, isTextBased: true },
      { index: 10000, label: "EN · SRT file", language: "eng", isDefault: false, isForced: false, isTextBased: true, isExternal: true },
    ]);
  });
});
