import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "@tessatv/auth";
import type {
  AuthSession,
  AuthSessionRepository,
  LibraryNode,
  LibraryRepository,
  MediaFile,
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

const NOW = new Date(0);
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
  const progress = new InMemoryProgress();
  const transcodeDir = () => join(root, "hls");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tessatv-playback-test-"));
    const files: MediaFile[] = ["e1", "e2", "film"].map((id) => ({
      id: `file-${id}`, unitId: id, path: join(root, `${id}.${id === "film" ? "mp4" : "mkv"}`),
      container: id === "film" ? "mp4" : "mkv", videoCodec: "h264", audioCodec: "aac", resolutionWidth: 1280,
      resolutionHeight: 720, sizeBytes: 26, checksum: null, importedAt: NOW,
    }));
    for (const file of files) await writeFile(file.path, "abcdefghijklmnopqrstuvwxyz");
    const library = new Library(
      [node("show", "collection", null, "series"), node("s1", "collection", "show", "series"), node("l1", "leaf", "s1", "series"), node("l2", "leaf", "s1", "series"), node("movie", "leaf", null, "movie")],
      [unit("e2", "l2", [1, 2]), unit("e1", "l1", [1, 1]), { ...unit("film", "movie", []), mediaType: "movie" }],
      files,
    );
    const fakeSession = (directory: string) =>
      ({ id: `session-${Math.random()}`, outputDirectory: directory, state: "running", progress: { outTimeSeconds: 0, speed: 1 },
        waitForPlaylist: async () => join(directory, "index.m3u8"), dispose: async () => {} }) as unknown as TranscodeSession;
    const transcodes = new TranscodeManager({
      directory: transcodeDir(),
      accel: new SoftwareAccel(),
      startSession: async (_plan, options) => {
        await writeFile(join(root, "playlist.m3u8"), "#EXTM3U\n");
        return fakeSession(options.directory);
      },
    });
    const auth = new AuthService(new InMemoryUsers(), new InMemorySessions());
    const { token } = await auth.completeSetup("viewer", "a-long-enough-password", null);
    headers = { authorization: `Bearer ${token}` };
    app = buildApp({
      libraryRepository: library,
      metadataProviders: {},
      auth,
      playback: {
        progressRepository: progress,
        metadataCache: null,
        transcodes,
        probe: async (path) => probeOf(path, path.endsWith(".mp4") ? "mp4" : "mkv"),
        extractSubtitles: async () => "WEBVTT\n\n00:01:40.000 --> 00:01:45.000\nHi\n",
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
    ]);
  });
});
