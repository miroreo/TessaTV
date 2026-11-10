import { describe, expect, it } from "vitest";
import { normalizationGainDb } from "./loudness.js";

describe("normalizationGainDb", () => {
  it("brings a stream to -23 LUFS", () => {
    expect(normalizationGainDb(-32.6)).toBe(9.6);
    expect(normalizationGainDb(-16)).toBe(-7);
    expect(normalizationGainDb(-23)).toBe(0);
  });

  it("caps the change at 12 dB either way, and leaves silence alone", () => {
    expect(normalizationGainDb(-45)).toBe(12);
    expect(normalizationGainDb(-5)).toBe(-12);
    expect(normalizationGainDb(-70)).toBe(0);
  });
});
