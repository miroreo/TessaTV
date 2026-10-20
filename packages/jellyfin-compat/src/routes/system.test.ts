import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerJellyfinCompat } from "../jellyfin-compat.js";
import { JELLYFIN_API_VERSION } from "../server-info.js";

function buildTestApp() {
  const app = Fastify({ routerOptions: { caseSensitive: false } });
  registerJellyfinCompat(app, { serverId: "0123456789abcdef0123456789abcdef", serverName: "TessaTV" });
  return app;
}

describe("system routes", () => {
  it("serves public system info without auth", async () => {
    const response = await buildTestApp().inject({
      method: "GET",
      url: "/System/Info/Public",
      headers: { host: "10.8.128.8:8080" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      LocalAddress: "http://10.8.128.8:8080",
      ServerName: "TessaTV",
      Version: JELLYFIN_API_VERSION,
      ProductName: "Jellyfin Server",
      OperatingSystem: "",
      Id: "0123456789abcdef0123456789abcdef",
      StartupWizardCompleted: true,
    });
  });

  it("matches routes case-insensitively, as Jellyfin clients expect", async () => {
    const response = await buildTestApp().inject({ method: "GET", url: "/system/info/public" });
    expect(response.statusCode).toBe(200);
  });

  it.each(["GET", "POST"] as const)("answers %s /System/Ping", async (method) => {
    const response = await buildTestApp().inject({ method, url: "/System/Ping" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBe("Jellyfin Server");
  });
});
