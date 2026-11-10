import type { LoudnessMeasurement, LoudnessRepository } from "@tessatv/domain";
import { describe, expect, it, vi } from "vitest";
import { measureLoudness, measureMissingLoudness, parseEbur128Summary } from "./loudness.js";
import { audioStream, mediaProbe } from "./test-fixtures.js";

const SUMMARY = `[Parsed_ebur128_0 @ 0x5555] Summary:

  Integrated loudness:
    I:         -32.6 LUFS
    Threshold: -43.1 LUFS

  Loudness range:
    LRA:         8.4 LU
    Threshold: -53.2 LUFS
    LRA low:   -38.2 LUFS
    LRA high:  -29.8 LUFS

  True peak:
    Peak:       -4.1 dBFS
`;

describe("parseEbur128Summary", () => {
  it("reads integrated loudness and true peak", () => {
    expect(parseEbur128Summary(SUMMARY)).toEqual({ integratedLufs: -32.6, truePeakDbtp: -4.1 });
  });

  it("treats silence (-inf) and a missing summary as unmeasurable", () => {
    expect(parseEbur128Summary(SUMMARY.replace("-32.6", "-inf").replace("-4.1", "-inf"))).toEqual({ integratedLufs: null, truePeakDbtp: null });
    expect(parseEbur128Summary("")).toEqual({ integratedLufs: null, truePeakDbtp: null });
  });
});

describe("measureLoudness", () => {
  it("measures the chosen stream at low priority", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: SUMMARY }));
    expect(await measureLoudness("/m.mkv", 3, { runner })).toEqual({ integratedLufs: -32.6, truePeakDbtp: -4.1 });
    const [command, args] = runner.mock.calls[0] as unknown as [string, string[]];
    expect([command, ...args.slice(0, 3)]).toEqual(["nice", "-n", "19", "ffmpeg"]);
    expect(args).toEqual(expect.arrayContaining(["-map", "0:3", "-af", "ebur128=peak=true:framelog=quiet"]));
  });
});

class Repo implements LoudnessRepository {
  saved: LoudnessMeasurement[] = [];
  constructor(private files: { id: string; path: string }[]) {}
  async get() {
    return null;
  }
  async save(measurement: LoudnessMeasurement) {
    this.saved.push(measurement);
    this.files = this.files.filter((file) => file.id !== measurement.mediaFileId);
  }
  async listUnmeasured(limit: number) {
    return this.files.slice(0, limit);
  }
}

describe("measureMissingLoudness", () => {
  const probe = async (path: string) =>
    path === "/broken.mkv"
      ? Promise.reject(new Error("ffprobe failed"))
      : mediaProbe({ path, audioStreams: [audioStream({ index: 1, isDefault: false }), audioStream({ index: 2, isDefault: true })] });

  it("measures each file's default audio stream and records failures instead of retrying them", async () => {
    const repository = new Repo([{ id: "a", path: "/a.mkv" }, { id: "b", path: "/broken.mkv" }]);
    const measure = vi.fn(async () => ({ integratedLufs: -30, truePeakDbtp: -1 }));
    expect(await measureMissingLoudness({ repository, budgetMs: 60_000, probe, measure })).toEqual({ measured: 1, failed: 1 });
    expect(measure).toHaveBeenCalledWith("/a.mkv", 2);
    expect(repository.saved.map((entry) => [entry.mediaFileId, entry.integratedLufs, entry.error])).toEqual([
      ["a", -30, null],
      ["b", null, "ffprobe failed"],
    ]);
  });

  it("stops starting files once its time budget is spent", async () => {
    let clock = 0;
    const repository = new Repo([{ id: "a", path: "/a.mkv" }, { id: "b", path: "/b.mkv" }]);
    const measure = async () => {
      clock += 1_000;
      return { integratedLufs: -23, truePeakDbtp: null };
    };
    const summary = await measureMissingLoudness({ repository, budgetMs: 500, probe, measure, now: () => clock });
    expect(summary).toEqual({ measured: 1, failed: 0 });
  });
});
