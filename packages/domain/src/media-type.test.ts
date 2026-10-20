import { describe, expect, it } from "vitest";
import { MediaTypeRegistry, type MediaTypeDescriptor } from "./media-type.js";

function descriptor(id: string, collectionLevels: string[]): MediaTypeDescriptor {
  return {
    id,
    displayName: id,
    collectionLevels,
    namingTokens: [],
    releaseParser: { mediaType: id, parse: () => null },
  };
}

describe("MediaTypeRegistry", () => {
  it("registers a flat type (Movie) and a nested type (Series) side by side", () => {
    const registry = new MediaTypeRegistry();
    registry.register(descriptor("movie", []));
    registry.register(descriptor("series", ["series", "season"]));

    expect(registry.get("movie").collectionLevels).toEqual([]);
    expect(registry.get("series").collectionLevels).toEqual(["series", "season"]);
    expect(registry.list()).toHaveLength(2);
  });

  it("rejects duplicate registration and unknown lookups", () => {
    const registry = new MediaTypeRegistry();
    registry.register(descriptor("movie", []));

    expect(() => registry.register(descriptor("movie", []))).toThrow();
    expect(() => registry.get("music")).toThrow();
  });
});
