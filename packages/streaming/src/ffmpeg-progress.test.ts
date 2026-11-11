import { describe, expect, it } from "vitest";
import { FfmpegProgressParser, type FfmpegProgress } from "./ffmpeg-progress.js";

function parse(...chunks: string[]): FfmpegProgress[] {
  const seen: FfmpegProgress[] = [];
  const parser = new FfmpegProgressParser((progress) => seen.push(progress));
  for (const chunk of chunks) parser.push(chunk);
  return seen;
}

describe("FfmpegProgressParser", () => {
  it("reports position, fps and speed once per finished block", () => {
    expect(parse("frame=50\nfps=98.5\nout_time_us=2000000\nspeed=4.01x\nprogress=continue\n")).toEqual([
      { outTimeSeconds: 2, fps: 98.5, speed: 4.01 },
    ]);
  });

  it("handles lines split across chunks, and both out_time keys", () => {
    expect(parse("out_time_m", "s=3000000\nspe", "ed=2x\nprogress=end\n")).toEqual([{ outTimeSeconds: 3, fps: null, speed: 2 }]);
  });

  it("keeps the previous value when ffmpeg reports a key it doesn't have yet, and says null for N/A", () => {
    expect(parse("fps=24\nout_time_us=1000000\nspeed=1x\nprogress=continue\n", "out_time_us=N/A\nspeed=N/A\nprogress=continue\n")).toEqual([
      { outTimeSeconds: 1, fps: 24, speed: 1 },
      { outTimeSeconds: 1, fps: 24, speed: null },
    ]);
  });

  it("says nothing until a block is finished", () => {
    expect(parse("fps=24\nout_time_us=1000000\n")).toEqual([]);
  });
});
