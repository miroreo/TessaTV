import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDiagnostics } from "../diagnostics.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";

describe("diagnostics routes", () => {
  let directory: string;
  const app = Fastify();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tessatv-diagnostics-routes-"));
    // Stands in for the auth hook: who is calling is decided by a header.
    app.addHook("onRequest", async (request) => {
      const who = request.headers["x-user"];
      if (who) request.user = { id: "u", username: String(who), isAdmin: who === "admin" };
    });
    const diagnostics = new MemoryDiagnostics({
      directory,
      captureAtMb: 1_000_000,
      onReport: () => {},
      profiler: { start: async () => {}, profile: async () => '{"head":{"callFrame":{"functionName":"(root)"}}}', stop: async () => {} },
      writeSnapshot: (path) => path,
    });
    registerDiagnosticsRoutes(app, { diagnostics });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("is admin-only", async () => {
    for (const [method, url] of [["GET", "/api/diagnostics/memory"], ["POST", "/api/diagnostics/heap-profile"], ["POST", "/api/diagnostics/heap-snapshot"]] as const) {
      expect((await app.inject({ method, url, headers: { "x-user": "viewer" } })).statusCode).toBe(403);
      expect((await app.inject({ method, url })).statusCode).toBe(403);
    }
  });

  it("reports the heap's size to an admin", async () => {
    const response = await app.inject({ method: "GET", url: "/api/diagnostics/memory", headers: { "x-user": "admin" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ heapUsedMb: expect.any(Number), heapLimitMb: expect.any(Number), rssMb: expect.any(Number) });
  });

  it("writes a heap profile and a snapshot on request, and says where", async () => {
    const profile = await app.inject({ method: "POST", url: "/api/diagnostics/heap-profile", headers: { "x-user": "admin" } });
    expect(profile.statusCode).toBe(200);
    const { path } = profile.json<{ path: string }>();
    expect(path.startsWith(directory) && path.endsWith(".heapprofile")).toBe(true);
    expect(await readFile(path, "utf8")).toContain("(root)");

    const snapshot = await app.inject({ method: "POST", url: "/api/diagnostics/heap-snapshot", headers: { "x-user": "admin" } });
    expect(snapshot.json<{ path: string }>().path.endsWith(".heapsnapshot")).toBe(true);
  });
});
