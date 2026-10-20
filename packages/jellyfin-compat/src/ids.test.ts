import { describe, expect, it } from "vitest";
import { deriveServerId, fromJellyfinId, toJellyfinId } from "./ids.js";

const UUID = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";

describe("Jellyfin ids", () => {
  it("round-trips a UUID through Jellyfin's dashless form", () => {
    expect(toJellyfinId(UUID)).toBe("3f2a9c1e7b4d4e8a9c0f1a2b3c4d5e6f");
    expect(fromJellyfinId(toJellyfinId(UUID))).toBe(UUID);
  });

  it("accepts dashed and uppercase ids", () => {
    expect(fromJellyfinId(UUID.toUpperCase())).toBe(UUID);
  });

  it("rejects anything that isn't a UUID", () => {
    expect(fromJellyfinId("not-an-id")).toBeNull();
    expect(fromJellyfinId("3f2a9c1e7b4d4e8a9c0f1a2b3c4d5e6")).toBeNull();
    expect(fromJellyfinId("")).toBeNull();
  });

  it("derives a stable 32-hex server id that differs per secret", () => {
    const id = deriveServerId("a".repeat(32));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveServerId("a".repeat(32))).toBe(id);
    expect(deriveServerId("b".repeat(32))).not.toBe(id);
  });
});
