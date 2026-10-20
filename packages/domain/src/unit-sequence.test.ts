import { describe, expect, it } from "vitest";
import { compareUnitSequence } from "./unit-sequence.js";

describe("compareUnitSequence", () => {
  it("orders movie-style empty sequences as equal", () => {
    expect(compareUnitSequence({ path: [] }, { path: [] })).toBe(0);
  });

  it("orders TV-style [season, episode] sequences numerically", () => {
    expect(compareUnitSequence({ path: [1, 2] }, { path: [1, 3] })).toBeLessThan(0);
    expect(compareUnitSequence({ path: [2, 1] }, { path: [1, 10] })).toBeGreaterThan(0);
    expect(compareUnitSequence({ path: [1, 2] }, { path: [1, 2] })).toBe(0);
  });
});
