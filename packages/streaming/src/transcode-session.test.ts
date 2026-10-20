import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SoftwareAccel } from "./hardware-accel/software.js";
import type { HlsPlaybackPlan } from "./playback-plan.js";
import type { ProcessSpawner, SpawnedProcess } from "./process.js";
import { startTranscodeSession } from "./transcode-session.js";

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  /** Exit code to use when signalled; null means ignore SIGTERM (only SIGKILL ends it). */
  exitOnSigterm: number | null = 255;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL") setImmediate(() => this.emit("exit", null, "SIGKILL"));
    else if (this.exitOnSigterm !== null) setImmediate(() => this.emit("exit", this.exitOnSigterm, null));
    return true;
  }

  exit(code: number) {
    this.emit("exit", code, null);
  }
}

const PLAN: HlsPlaybackPlan = {
  mode: "remux",
  path: "/media/show.mkv",
  segmentContainer: "mpegts",
  video: { kind: "copy", streamIndex: 0, codec: "h264" },
  audio: { kind: "copy", streamIndex: 1, codec: "aac" },
  reasons: ["ContainerNotSupported"],
};

describe("TranscodeSession", () => {
  let root: string;
  let fake: FakeProcess;
  let spawned: { command: string; args: readonly string[] }[];
  const spawner: ProcessSpawner = (command, args) => {
    spawned.push({ command, args });
    return fake;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tessatv-session-test-"));
    fake = new FakeProcess();
    spawned = [];
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const start = (overrides: { killTimeoutMs?: number } = {}) =>
    startTranscodeSession(PLAN, {
      accel: new SoftwareAccel(),
      directory: join(root, "out"),
      ffmpegPath: "/bin/ffmpeg",
      spawner,
      ...overrides,
    });

  it("creates the output directory and spawns ffmpeg with the built args", async () => {
    const session = await start();
    expect((await stat(join(root, "out"))).isDirectory()).toBe(true);
    expect(spawned[0]?.command).toBe("/bin/ffmpeg");
    expect(spawned[0]?.args.at(-1)).toBe(join(root, "out", "index.m3u8"));
    expect(session.playlistPath).toBe(join(root, "out", "index.m3u8"));
    expect(session.state).toBe("running");
  });

  it("refuses direct-play plans", async () => {
    await expect(
      startTranscodeSession(
        { mode: "direct-play", path: "/x.mp4", reasons: [] },
        { accel: new SoftwareAccel(), directory: root, spawner },
      ),
    ).rejects.toThrow(/serve the file directly/);
  });

  it("parses -progress blocks, including ones split across chunks", async () => {
    const session = await start();
    const seen: number[] = [];
    session.onProgress((progress) => seen.push(progress.outTimeSeconds));

    fake.stdout.write("frame=10\nout_time_us=1500000\nspe");
    fake.stdout.write("ed=4.25x\nprogress=continue\n");
    fake.stdout.write("out_time_us=N/A\nspeed=N/A\nprogress=continue\n");
    fake.stdout.write("out_time_ms=3000000\nprogress=end\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([1.5, 1.5, 3]);
    expect(session.progress).toEqual({ outTimeSeconds: 3, speed: null });
  });

  it("completes on exit code 0", async () => {
    const session = await start();
    fake.exit(0);
    expect(await session.done).toEqual({ state: "completed", error: null });
    expect(session.state).toBe("completed");
  });

  it("fails with ffmpeg's stderr on a non-zero exit", async () => {
    const session = await start();
    fake.stderr.write("[hevc] Invalid data found\n");
    await new Promise((resolve) => setImmediate(resolve));
    fake.exit(1);
    expect(await session.done).toEqual({ state: "failed", error: "[hevc] Invalid data found" });
  });

  it("reports a spawn error as failed", async () => {
    const session = await start();
    fake.emit("error", new Error("spawn ffmpeg ENOENT"));
    expect(await session.done).toEqual({ state: "failed", error: "spawn ffmpeg ENOENT" });
  });

  it("stop() sends SIGTERM and reports stopped rather than failed", async () => {
    const session = await start();
    expect(await session.stop()).toEqual({ state: "stopped", error: null });
    expect(fake.signals).toEqual(["SIGTERM"]);
    // Idempotent once stopped.
    await session.stop();
    expect(fake.signals).toEqual(["SIGTERM"]);
  });

  it("stop() escalates to SIGKILL when ffmpeg ignores SIGTERM", async () => {
    fake.exitOnSigterm = null;
    const session = await start({ killTimeoutMs: 10 });
    expect((await session.stop()).state).toBe("stopped");
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("waitForPlaylist resolves once ffmpeg writes the playlist", async () => {
    const session = await start();
    const waiting = session.waitForPlaylist(2_000, 5);
    await writeFile(session.playlistPath, "#EXTM3U\n");
    await expect(waiting).resolves.toBe(session.playlistPath);
  });

  it("waitForPlaylist rejects if ffmpeg exits without one", async () => {
    const session = await start();
    const waiting = session.waitForPlaylist(2_000, 5);
    fake.stderr.write("No such file or directory\n");
    await new Promise((resolve) => setImmediate(resolve));
    fake.exit(1);
    await expect(waiting).rejects.toThrow(/failed before producing a playlist: No such file or directory/);
  });

  it("waitForPlaylist times out", async () => {
    const session = await start();
    await expect(session.waitForPlaylist(20, 5)).rejects.toThrow(/Timed out/);
  });

  it("dispose() stops ffmpeg and removes its output", async () => {
    const session = await start();
    await writeFile(join(session.outputDirectory, "segment00000.ts"), "");
    await session.dispose();
    expect(session.state).toBe("stopped");
    await expect(stat(session.outputDirectory)).rejects.toThrow();
  });
});
