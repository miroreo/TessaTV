import type { FileHealth, FileHealthRepository } from "@tessatv/domain";
import { describe, expect, it } from "vitest";
import { checkFileHealth, FileHealthMonitor } from "./file-health.js";
import type { CommandRunner } from "./process.js";

describe("checkFileHealth", () => {
  const result = (exitCode: number, stderr = "") => ({ exitCode, stdout: "", stderr });

  it("decodes on the CPU, throttled and at the lowest priority", async () => {
    let command: readonly string[] = [];
    const runner: CommandRunner = async (name, args) => {
      command = [name, ...args];
      return result(0);
    };
    await checkFileHealth("/media/a.mkv", { runner, readRate: 2 });
    expect(command.slice(0, 4)).toEqual(["nice", "-n", "19", "ffmpeg"]);
    expect(command).toEqual(expect.arrayContaining(["-threads", "1", "-readrate", "2", "-i", "/media/a.mkv", "null"]));
    expect(command).not.toContain("-hwaccel");
  });

  it("is damaged when ffmpeg exits non-zero or prints errors, even on a zero exit", async () => {
    expect(await checkFileHealth("/a", { runner: async () => result(0) })).toBeNull();
    expect(await checkFileHealth("/a", { runner: async () => result(0, "[hevc] Error constructing the frame RPS.\n") })).toBe(
      "[hevc] Error constructing the frame RPS.",
    );
    expect(await checkFileHealth("/a", { runner: async () => result(183, "[h264] error while decoding MB 4 2\n") })).toBe(
      "[h264] error while decoding MB 4 2",
    );
    expect(await checkFileHealth("/a", { runner: async () => result(1) })).toBe("ffmpeg exited with code 1");
  });

  it("ignores non-monotonic dts messages from the null muxer, but still reports real errors after them", async () => {
    const dts = "[null @ 0x5b] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 2 >= 2\n".repeat(50);
    expect(await checkFileHealth("/a", { runner: async () => result(0, dts) })).toBeNull();
    expect(await checkFileHealth("/a", { runner: async () => result(0, `${dts}[h264] error while decoding MB 4 2\n`) })).toBe(
      "[h264] error while decoding MB 4 2",
    );
    expect(await checkFileHealth("/a", { runner: async () => result(1, dts) })).toBe("ffmpeg exited with code 1");
  });

  it("at full speed drops the read-rate throttle and the one-thread limit, but keeps the lowest priority", async () => {
    let command: readonly string[] = [];
    const runner: CommandRunner = async (name, args) => {
      command = [name, ...args];
      return result(0);
    };
    await checkFileHealth("/a", { runner, fullSpeed: true });
    expect(command.slice(0, 4)).toEqual(["nice", "-n", "19", "ffmpeg"]);
    expect(command).not.toContain("-readrate");
    expect(command).not.toContain("-threads");
    await checkFileHealth("/a", { runner });
    expect(command).toEqual(expect.arrayContaining(["-readrate", "4", "-threads", "1"]));
  });

  it("reports progress from ffmpeg's -progress output while it runs", async () => {
    let command: readonly string[] = [];
    const seen: number[] = [];
    await checkFileHealth("/a", {
      onProgress: ({ outTimeSeconds }) => seen.push(outTimeSeconds),
      runner: async (name, args, options) => {
        command = [name, ...args];
        options?.onStdout?.("fps=90\nout_time_us=5000000\nspeed=4x\nprogress=continue\n");
        options?.onStdout?.("fps=95\nout_time_us=6000000\nspeed=4x\nprogress=end\n");
        return result(0);
      },
    });
    expect(command).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(seen).toEqual([5, 6]);
  });

  it("stops at the first decode error", async () => {
    let command: readonly string[] = [];
    await checkFileHealth("/a", {
      runner: async (name, args) => {
        command = [name, ...args];
        return result(0);
      },
    });
    expect(command).toContain("-xerror");
  });

  it("keeps the reported error short", async () => {
    expect((await checkFileHealth("/a", { runner: async () => result(1, "x".repeat(5000)) }))?.length).toBe(500);
  });
});

class FakeRepository implements FileHealthRepository {
  readonly saved: FileHealth[] = [];
  constructor(private due: { id: string; path: string; sizeBytes: number }[]) {}
  async get() {
    return null;
  }
  async save(health: FileHealth) {
    this.saved.push(health);
    this.due = this.due.filter((file) => file.id !== health.mediaFileId);
  }
  async summary() {
    return { total: 0, clean: 0, damaged: 0, due: 0 };
  }
  async listDamaged() {
    return [];
  }
  async listDue(limit: number) {
    return this.due.slice(0, limit);
  }
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

describe("FileHealthMonitor", () => {
  const files = [
    { id: "1", path: "/media/1.mkv", sizeBytes: 10 },
    { id: "2", path: "/media/2.mkv", sizeBytes: 20 },
  ];

  it("checks each due file once and records the outcome", async () => {
    const repository = new FakeRepository([...files]);
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isBusy: () => false,
      check: async (path) => (path.endsWith("2.mkv") ? "bad frame" : null),
      exists: async () => true,
      idleMs: 5,
    });
    monitor.start();
    await until(() => repository.saved.length === 2);
    await monitor.stop();
    expect(repository.saved.map(({ mediaFileId, sizeBytes, error }) => ({ mediaFileId, sizeBytes, error }))).toEqual([
      { mediaFileId: "1", sizeBytes: 10, error: null },
      { mediaFileId: "2", sizeBytes: 20, error: "bad frame" },
    ]);
  });

  it("waits while a transcode is running", async () => {
    const repository = new FakeRepository([...files]);
    let busy = true;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isBusy: () => busy,
      check: async () => null,
      exists: async () => true,
      busyMs: 5,
      idleMs: 5,
    });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(repository.saved).toHaveLength(0);
    busy = false;
    await until(() => repository.saved.length === 2);
    await monitor.stop();
  });

  it("does nothing while disabled, and starts once it's turned on", async () => {
    const repository = new FakeRepository([...files]);
    let enabled = false;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => enabled,
      isBusy: () => false,
      check: async () => null,
      exists: async () => true,
      disabledMs: 5,
      idleMs: 5,
    });
    monitor.start();
    await until(() => monitor.status().state === "disabled");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(repository.saved).toHaveLength(0);
    enabled = true;
    await until(() => repository.saved.length === 2);
    await monitor.stop();
  });

  it("abandons a check in progress when it's turned off, without recording it", async () => {
    const repository = new FakeRepository([...files]);
    let enabled = true;
    let started = false;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => enabled,
      isBusy: () => false,
      exists: async () => true,
      check: (_path, signal) =>
        new Promise((_resolve, reject) => {
          started = true;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      enabledPollMs: 5,
      disabledMs: 5,
    });
    monitor.start();
    await until(() => started);
    expect(monitor.status()).toMatchObject({ state: "checking", current: { path: "/media/1.mkv" } });
    enabled = false;
    await until(() => monitor.status().state === "disabled");
    expect(monitor.status().current).toBeNull();
    expect(repository.saved).toHaveLength(0);
    await monitor.stop();
  });

  it("exposes how far the file being checked has got: length, position, fps and speed", async () => {
    const repository = new FakeRepository([files[0]!]);
    let finish: () => void = () => undefined;
    let report: Parameters<NonNullable<ConstructorParameters<typeof FileHealthMonitor>[0]["check"]>>[2] = () => undefined;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isBusy: () => false,
      exists: async () => true,
      duration: async () => 600,
      check: (_path, _signal, onProgress) =>
        new Promise((resolve) => {
          report = onProgress;
          finish = () => resolve(null);
        }),
    });
    monitor.start();
    await until(() => monitor.status().current?.durationSeconds === 600);
    expect(monitor.status().current).toMatchObject({ path: "/media/1.mkv", positionSeconds: 0, fps: null, speed: null });
    report({ outTimeSeconds: 150, fps: 96, speed: 4 });
    expect(monitor.status().current).toMatchObject({ durationSeconds: 600, positionSeconds: 150, fps: 96, speed: 4 });
    finish();
    await until(() => monitor.status().current === null);
    await monitor.stop();
  });

  it("keeps checking through a transcode at full speed, telling the check so", async () => {
    const repository = new FakeRepository([...files]);
    const modes: boolean[] = [];
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isFullSpeed: async () => true,
      isBusy: () => true,
      check: async (_path, _signal, _onProgress, fullSpeed) => {
        modes.push(fullSpeed);
        return null;
      },
      exists: async () => true,
      duration: async () => null,
      busyMs: 5,
      idleMs: 5,
    });
    monitor.start();
    await until(() => repository.saved.length === 2);
    expect(modes).toEqual([true, true]);
    expect(monitor.status().fullSpeed).toBe(true);
    await monitor.stop();
  });

  it("restarts the check in progress when full speed is switched, so it takes effect now", async () => {
    const repository = new FakeRepository([files[0]!]);
    let fullSpeed = false;
    const started: boolean[] = [];
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isFullSpeed: async () => fullSpeed,
      isBusy: () => false,
      exists: async () => true,
      duration: async () => null,
      check: (_path, signal, _onProgress, mode) =>
        new Promise((resolve, reject) => {
          started.push(mode);
          if (mode) resolve(null);
          else signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      enabledPollMs: 5,
      idleMs: 5,
    });
    monitor.start();
    await until(() => started.length === 1);
    fullSpeed = true;
    await until(() => repository.saved.length === 1);
    expect(started).toEqual([false, true]);
    await monitor.stop();
  });

  it("reports waiting while a transcode runs, and idle once nothing is due", async () => {
    const repository = new FakeRepository([]);
    let busy = true;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isBusy: () => busy,
      check: async () => null,
      exists: async () => true,
      busyMs: 5,
      idleMs: 5,
    });
    monitor.start();
    await until(() => monitor.status().state === "waiting");
    busy = false;
    await until(() => monitor.status().state === "idle");
    await monitor.stop();
  });

  it("skips a file it can't check instead of retrying it, and carries on", async () => {
    const repository = new FakeRepository([...files]);
    const errors: string[] = [];
    let attempts = 0;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isBusy: () => false,
      check: async (path) => {
        if (path.endsWith("1.mkv")) {
          attempts += 1;
          throw new Error("ffmpeg missing");
        }
        return null;
      },
      exists: async () => true,
      onError: (path) => errors.push(path),
      idleMs: 5,
    });
    monitor.start();
    await until(() => repository.saved.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await monitor.stop();
    expect(attempts).toBe(1);
    expect(errors).toEqual(["/media/1.mkv"]);
    expect(repository.saved[0]?.mediaFileId).toBe("2");
  });

  it("doesn't check a file that has gone missing", async () => {
    const repository = new FakeRepository([files[0]!]);
    let checked = false;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isBusy: () => false,
      check: async () => ((checked = true), null),
      exists: async () => false,
      onError: () => undefined,
      idleMs: 5,
    });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await monitor.stop();
    expect(checked).toBe(false);
    expect(repository.saved).toHaveLength(0);
  });

  it("stops promptly, abandoning a check in progress without recording it", async () => {
    const repository = new FakeRepository([...files]);
    let started = false;
    const monitor = new FileHealthMonitor({
      repository,
      isEnabled: async () => true,
      isBusy: () => false,
      exists: async () => true,
      check: (_path, signal) =>
        new Promise((_resolve, reject) => {
          started = true;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    monitor.start();
    await until(() => started);
    await monitor.stop();
    expect(repository.saved).toHaveLength(0);
  });
});
