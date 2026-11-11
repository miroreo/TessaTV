import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareAccel } from "./hardware-accel/hardware-accel.js";
import { SoftwareAccel } from "./hardware-accel/software.js";
import type { HlsPlaybackPlan } from "./playback-plan.js";
import { TranscodeCapacityError, TranscodeManager } from "./transcode-manager.js";
import type { startTranscodeSession, TranscodeSession } from "./transcode-session.js";

const PLAN: HlsPlaybackPlan = {
  mode: "remux",
  path: "/media/show.mkv",
  segmentContainer: "fmp4",
  video: { kind: "copy", streamIndex: 0, codec: "hevc" },
  audio: { kind: "copy", streamIndex: 1, codec: "aac" },
  subtitle: null,
  reasons: ["ContainerNotSupported"],
  fallbackLevel: 0,
};

function fakeSession(outTimeSeconds = 0, state = "running", fails = false) {
  return {
    state,
    progress: { outTimeSeconds, speed: 1 },
    waitForPlaylist: vi.fn(async () => {
      if (fails) throw new Error("Transcode failed before producing a playlist");
      return "index.m3u8";
    }),
    dispose: vi.fn(async () => {}),
  };
}

describe("TranscodeManager", () => {
  let directory: string;
  let nowMs: number;
  let sessions: ReturnType<typeof fakeSession>[];
  let startSession: ReturnType<typeof vi.fn>;

  const manager = (maxConcurrent = 2) =>
    new TranscodeManager({
      directory,
      accel: new SoftwareAccel(),
      maxConcurrent,
      idleTimeoutMs: 1_000,
      now: () => nowMs,
      startSession: startSession as unknown as typeof startTranscodeSession,
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tessatv-manager-test-"));
    nowMs = 0;
    sessions = [];
    startSession = vi.fn(async () => {
      const session = fakeSession();
      sessions.push(session);
      return session as unknown as TranscodeSession;
    });
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("refuses to run more than the limit, but doesn't count finished transcodes", async () => {
    const transcodes = manager(1);
    await transcodes.begin(PLAN);
    await expect(transcodes.begin(PLAN)).rejects.toBeInstanceOf(TranscodeCapacityError);

    sessions[0]!.state = "completed";
    await expect(transcodes.begin(PLAN)).resolves.toBeDefined();
  });

  it("reaps transcodes nobody has touched, freeing capacity", async () => {
    const transcodes = manager(1);
    const first = await transcodes.begin(PLAN);
    nowMs = 1_001;
    await transcodes.begin(PLAN);
    expect(sessions[0]!.dispose).toHaveBeenCalled();
    expect(transcodes.touch(first.id)).toBeNull();
  });

  it("keeps a transcode alive while it's being touched", async () => {
    const transcodes = manager(2);
    const first = await transcodes.begin(PLAN);
    nowMs = 900;
    expect(transcodes.touch(first.id)).not.toBeNull();
    nowMs = 1_500;
    await transcodes.begin(PLAN);
    expect(sessions[0]!.dispose).not.toHaveBeenCalled();
  });

  it("doesn't restart ffmpeg for a seek into what's already transcoded", async () => {
    const transcodes = manager();
    const { id } = await transcodes.begin(PLAN, 100);
    sessions[0]!.progress = { outTimeSeconds: 60, speed: 1 };
    const sought = await transcodes.seek(id, 150);
    expect(sought?.session).toBe(sessions[0]);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it.each([[500], [50]])("restarts at the new position for a seek outside it (%d)", async (seconds) => {
    const transcodes = manager();
    const { id } = await transcodes.begin(PLAN, 100);
    sessions[0]!.progress = { outTimeSeconds: 60, speed: 1 };
    const sought = await transcodes.seek(id, seconds);
    expect(sessions[0]!.dispose).toHaveBeenCalled();
    expect(sought).toMatchObject({ id, startTimeSeconds: seconds, session: sessions[1] });
    const directories = startSession.mock.calls.map((call) => (call[1] as { directory: string }).directory);
    expect(new Set(directories).size).toBe(2);
  });

  it("drops the transcode when a seek's restart fails, instead of keeping a disposed session", async () => {
    const transcodes = manager();
    const { id } = await transcodes.begin(PLAN, 100);
    sessions[0]!.progress = { outTimeSeconds: 60, speed: 1 };
    startSession.mockRejectedValueOnce(new Error("ffmpeg failed to start"));
    await expect(transcodes.seek(id, 500)).rejects.toThrow("ffmpeg failed to start");
    expect(transcodes.touch(id)).toBeNull();
  });

  it("returns null for unknown ids", async () => {
    const transcodes = manager();
    expect(transcodes.touch("nope")).toBeNull();
    await expect(transcodes.seek("nope", 1)).resolves.toBeNull();
  });

  it("on start, clears its own orphaned output and nothing else in the directory", async () => {
    await mkdir(join(directory, "session-orphan"));
    await writeFile(join(directory, "not-ours.txt"), "keep");
    const transcodes = manager();
    await transcodes.start();
    expect(await readdir(directory)).toEqual(["not-ours.txt"]);
    await transcodes.shutdown();
  });

  it("shutdown disposes everything and removes each session's directory", async () => {
    const transcodes = manager();
    await transcodes.begin(PLAN);
    const stale = join(directory, (await transcodes.begin(PLAN)).id);
    await transcodes.shutdown();
    expect(sessions.every((session) => session.dispose.mock.calls.length === 1)).toBe(true);
    expect((await readdir(directory)).some((name) => name.includes(stale))).toBe(false);
  });

  describe("CPU fallback", () => {
    const gpu: HardwareAccel = {
      kind: "vaapi",
      deviceName: "Test GPU",
      videoPipeline: (request) => ({ ...new SoftwareAccel().videoPipeline(request), decode: "hardware", encode: "hardware" }),
    };
    const TRANSCODE_PLAN: HlsPlaybackPlan = {
      ...PLAN,
      mode: "transcode",
      video: { kind: "transcode", streamIndex: 0, source: {} as never, codec: "h264", width: 1280, height: 720, bitrate: 4_000_000 },
    };
    const accelsUsed = () => startSession.mock.calls.map((call) => (call[1] as { accel: HardwareAccel }).accel.kind);

    function failingFirst() {
      let calls = 0;
      startSession = vi.fn(async () => {
        const session = fakeSession(0, "running", calls++ === 0);
        sessions.push(session);
        return session as unknown as TranscodeSession;
      });
    }

    it("retries a failed hardware transcode on the CPU, and keeps the CPU for later seeks", async () => {
      failingFirst();
      const onFallback = vi.fn();
      const transcodes = new TranscodeManager({
        directory, accel: gpu, onFallback, startSession: startSession as unknown as typeof startTranscodeSession,
      });
      const transcode = await transcodes.begin(TRANSCODE_PLAN);
      expect(accelsUsed()).toEqual(["vaapi", "none"]);
      expect(sessions[0]!.dispose).toHaveBeenCalled();
      expect(transcode.session).toBe(sessions[1]);
      expect(onFallback).toHaveBeenCalledWith(expect.any(Error), TRANSCODE_PLAN);

      await transcodes.seek(transcode.id, 500);
      expect(accelsUsed()).toEqual(["vaapi", "none", "none"]);
      expect(transcodes.inspect(transcode.id)).toMatchObject({
        accelKind: "none",
        videoPipeline: { decode: "software", encode: "software" },
        hardwareError: "Transcode failed before producing a playlist",
      });
    });

    it("skips the GPU at fallback level 2, and tries it again at the lower resolution of level 3", async () => {
      const transcodes = new TranscodeManager({ directory, accel: gpu, startSession: startSession as unknown as typeof startTranscodeSession });
      const transcode = await transcodes.begin({ ...TRANSCODE_PLAN, fallbackLevel: 2 });
      expect(accelsUsed()).toEqual(["none"]);
      expect(transcode.hardwareError).toBeNull();
      await transcodes.begin({ ...TRANSCODE_PLAN, fallbackLevel: 3 });
      expect(accelsUsed()).toEqual(["none", "vaapi"]);
    });

    it("doesn't retry a remux or a software failure — the CPU would fail the same way", async () => {
      failingFirst();
      const remuxing = new TranscodeManager({ directory, accel: gpu, startSession: startSession as unknown as typeof startTranscodeSession });
      await expect(remuxing.begin(PLAN)).rejects.toThrow(/before producing a playlist/);

      failingFirst();
      await expect(manager().begin(TRANSCODE_PLAN)).rejects.toThrow(/before producing a playlist/);
      expect(startSession).toHaveBeenCalledTimes(1);
    });
  });
});
