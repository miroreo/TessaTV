import type { LibraryNode, LibraryRepository, MediaFile, Unit } from "@tessatv/domain";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { NodeRequestHandler } from "./routes/web-ui.js";

function fakeNode(overrides: Partial<LibraryNode> = {}): LibraryNode {
  return {
    id: "node-1",
    mediaType: "movie",
    kind: "leaf",
    parentId: null,
    title: "Example Movie",
    sortTitle: "example movie",
    sourceKey: "Example Movie (1999)",
    externalIds: [],
    monitored: true,
    qualityProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

class InMemoryLibraryRepository implements LibraryRepository {
  constructor(private readonly nodes: LibraryNode[] = [], private readonly units: Unit[] = []) {}

  async getNode(id: string) {
    return this.nodes.find((node) => node.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((node) => node.parentId === parentId);
  }
  async createNode() {}
  async updateNode() {}
  async deleteNode() {}
  async getUnit(id: string) {
    return this.units.find((unit) => unit.id === id) ?? null;
  }
  async listUnits(libraryNodeId: string) {
    return this.units.filter((unit) => unit.libraryNodeId === libraryNodeId);
  }
  async createUnit() {}
  async updateUnit() {}
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

describe("GET /health", () => {
  it("reports ok", async () => {
    const app = buildApp({ metadataProviders: {}, libraryRepository:new InMemoryLibraryRepository() });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/library", () => {
  it("lists root library nodes", async () => {
    const repo = new InMemoryLibraryRepository([fakeNode()]);
    const app = buildApp({ metadataProviders: {}, libraryRepository:repo });

    const response = await app.inject({ method: "GET", url: "/api/library" });
    const body = response.json<{ items: LibraryNode[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("Example Movie");
  });
});

describe("GET /api/library/:id/units", () => {
  it("returns 404 for an unknown node", async () => {
    const app = buildApp({ metadataProviders: {}, libraryRepository:new InMemoryLibraryRepository() });
    const response = await app.inject({ method: "GET", url: "/api/library/missing/units" });
    expect(response.statusCode).toBe(404);
  });
});

describe("jellyfin-compat mounting", () => {
  it("serves Jellyfin discovery at the root, case-insensitively, alongside /api", async () => {
    const app = buildApp({
      metadataProviders: {},
      libraryRepository: new InMemoryLibraryRepository(),
      jellyfin: { serverId: "0123456789abcdef0123456789abcdef", serverName: "TessaTV" },
    });
    const info = await app.inject({ method: "GET", url: "/system/info/public" });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ Id: "0123456789abcdef0123456789abcdef", ProductName: "Jellyfin Server" });
    expect((await app.inject({ method: "GET", url: "/api/library" })).statusCode).toBe(200);
  });
});

describe("web UI mounting", () => {
  const webUiHandler: NodeRequestHandler = (req, res, next) => {
    if (req.url === "/missing") return next();
    res.setHeader("content-type", "text/html");
    res.end(`<p>ui:${req.url}</p>`);
  };
  const app = () =>
    buildApp({
      metadataProviders: {},
      libraryRepository: new InMemoryLibraryRepository(),
      jellyfin: { serverId: "0123456789abcdef0123456789abcdef", serverName: "TessaTV" },
      webUiHandler,
    });

  it("serves the UI at the root, where Jellyfin Mobile's web view lands", async () => {
    expect((await app().inject({ method: "GET", url: "/" })).body).toBe("<p>ui:/</p>");
    expect((await app().inject({ method: "GET", url: "/library/abc?x=1" })).body).toBe("<p>ui:/library/abc?x=1</p>");
    expect((await app().inject({ method: "GET", url: "/_app/immutable/start.js" })).body).toBe(
      "<p>ui:/_app/immutable/start.js</p>",
    );
  });

  it("leaves explicit routes to Fastify", async () => {
    expect((await app().inject({ method: "GET", url: "/api/library" })).json()).toEqual({ items: [] });
    expect((await app().inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    expect((await app().inject({ method: "GET", url: "/System/Info/Public" })).json()).toMatchObject({
      ProductName: "Jellyfin Server",
    });
  });

  it("tells SvelteKit the real protocol, ignoring a client-supplied header", async () => {
    let seen: string | string[] | undefined;
    const spy: NodeRequestHandler = (req, res) => {
      seen = req.headers["x-tessatv-forwarded-proto"];
      res.end();
    };
    const spyApp = buildApp({ metadataProviders: {}, libraryRepository: new InMemoryLibraryRepository(), webUiHandler: spy });
    await spyApp.inject({ method: "GET", url: "/", headers: { "x-tessatv-forwarded-proto": "https" } });
    expect(seen).toBe("http");
  });

  it("404s when SvelteKit passes on a request, and for non-GET unknown routes", async () => {
    expect((await app().inject({ method: "GET", url: "/missing" })).statusCode).toBe(404);
    expect((await app().inject({ method: "POST", url: "/nope" })).statusCode).toBe(404);
  });
});
