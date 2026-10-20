import type { LibraryNode, LibraryRepository, MediaFile } from "@tessatv/domain";
import type { MetadataProvider } from "@tessatv/metadata";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";

class InMemoryLibraryRepository implements LibraryRepository {
  nodes: LibraryNode[] = [];

  async getNode(id: string) {
    return this.nodes.find((node) => node.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((node) => node.parentId === parentId);
  }
  async createNode(node: LibraryNode) {
    this.nodes.push(node);
  }
  async updateNode(node: LibraryNode) {
    const index = this.nodes.findIndex((existing) => existing.id === node.id);
    if (index >= 0) this.nodes[index] = node;
  }
  async getUnit() {
    return null;
  }
  async listUnits() {
    return [];
  }
  async createUnit() {}
  async updateUnit() {}
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

function fakeProvider(): MetadataProvider {
  return {
    id: "tmdb",
    search: vi.fn().mockResolvedValue([{ externalId: "603", title: "Some Movie", year: 2000, overview: null, posterUrl: null }]),
    fetchDetails: vi.fn().mockResolvedValue({
      externalId: "603",
      title: "Some Movie (Canonical)",
      overview: null,
      year: 2000,
      posterUrl: null,
      backdropUrl: null,
    }),
  };
}

let moviesRoot: string;

beforeEach(async () => {
  moviesRoot = await mkdtemp(join(tmpdir(), "tessatv-import-route-"));
  const movieFolder = join(moviesRoot, "Some Movie (2000)");
  await mkdir(movieFolder, { recursive: true });
  await writeFile(join(movieFolder, "movie.mkv"), Buffer.alloc(100));
});

afterEach(async () => {
  await rm(moviesRoot, { recursive: true, force: true });
});

describe("POST /api/library/import", () => {
  it("does not attempt identification when no metadata provider is configured", async () => {
    const app = buildApp({ libraryRepository: new InMemoryLibraryRepository(), metadataProviders: {} });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/import",
      payload: { moviesPath: moviesRoot },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().identify).toBeUndefined();
  });

  it("automatically identifies newly-imported items when a provider is configured", async () => {
    const repo = new InMemoryLibraryRepository();
    const provider = fakeProvider();
    const app = buildApp({ libraryRepository: repo, metadataProviders: { movie: provider } });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/import",
      payload: { moviesPath: moviesRoot },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ movies: { created: number }; identify: { identified: unknown[] } }>();
    expect(body.movies.created).toBe(1);
    expect(body.identify.identified).toHaveLength(1);
    expect(repo.nodes[0]?.title).toBe("Some Movie (Canonical)");
  });
});
