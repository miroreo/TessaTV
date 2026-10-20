import { describe, expect, it } from "vitest";
import {
  toDomainLibraryNode,
  toDomainMediaFile,
  toDomainQualityDefinition,
  toDomainQualityProfile,
  toDomainUnit,
} from "./mappers.js";

describe("toDomainLibraryNode", () => {
  it("maps a flat Movie row (no collection ancestors) with its external ids attached", () => {
    const now = new Date();
    const node = toDomainLibraryNode(
      {
        id: "node-1",
        mediaType: "movie",
        kind: "leaf",
        parentId: null,
        title: "Example Movie",
        sortTitle: "example movie",
        monitored: true,
        qualityProfileId: null,
        createdAt: now,
        updatedAt: now,
      },
      [{ provider: "tmdb", entityType: "library_node", entityId: "node-1", providerId: "123" }],
    );

    expect(node.kind).toBe("leaf");
    expect(node.externalIds).toHaveLength(1);
    expect(node.externalIds[0]?.provider).toBe("tmdb");
  });
});

describe("toDomainUnit", () => {
  it("maps a TV-style [season, episode] sequence path from jsonb", () => {
    const now = new Date();
    const unit = toDomainUnit(
      {
        id: "unit-1",
        libraryNodeId: "node-1",
        mediaType: "series",
        title: "Pilot",
        sequencePath: [1, 1],
        availability: "available",
        mediaFileId: "file-1",
        createdAt: now,
        updatedAt: now,
      },
      [],
    );

    expect(unit.sequence.path).toEqual([1, 1]);
    expect(unit.availability).toBe("available");
  });
});

describe("toDomainMediaFile", () => {
  it("passes through file attributes unchanged", () => {
    const now = new Date();
    const file = toDomainMediaFile({
      id: "file-1",
      unitId: "unit-1",
      path: "/library/movie.mkv",
      container: "mkv",
      videoCodec: "h264",
      audioCodec: "aac",
      resolutionWidth: 1920,
      resolutionHeight: 1080,
      sizeBytes: 123456,
      checksum: null,
      importedAt: now,
    });

    expect(file.path).toBe("/library/movie.mkv");
    expect(file.resolutionWidth).toBe(1920);
  });
});

describe("toDomainQualityDefinition / toDomainQualityProfile", () => {
  it("maps quality definitions and profiles without any media-type field", () => {
    const definition = toDomainQualityDefinition({ id: "q-1", name: "1080p", rank: 3 });
    expect(definition).toEqual({ id: "q-1", name: "1080p", rank: 3 });

    const profile = toDomainQualityProfile({
      id: "p-1",
      name: "HD",
      allowedQualityIds: ["q-1", "q-2"],
      cutoffQualityId: "q-2",
    });
    expect(profile.allowedQualityIds).toEqual(["q-1", "q-2"]);
  });
});
