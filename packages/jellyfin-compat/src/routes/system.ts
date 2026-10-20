import type { FastifyInstance, FastifyRequest } from "fastify";
import type { JellyfinServerInfo } from "../server-info.js";

/** What every Jellyfin client fetches first to decide whether a URL is a usable server. */
export function publicSystemInfo(server: JellyfinServerInfo, request: FastifyRequest) {
  return {
    LocalAddress: `${request.protocol}://${request.host}`,
    ServerName: server.name,
    Version: server.version,
    ProductName: "Jellyfin Server",
    // Deprecated in Jellyfin itself but still part of the response shape.
    OperatingSystem: "",
    Id: server.id,
    StartupWizardCompleted: true,
  };
}

export function registerSystemRoutes(app: FastifyInstance, server: JellyfinServerInfo): void {
  app.get("/System/Info/Public", async (request) => publicSystemInfo(server, request));

  // Clients ping with both verbs; Jellyfin answers with its product name as a JSON string.
  app.route({
    method: ["GET", "POST"],
    url: "/System/Ping",
    handler: async (_request, reply) => reply.type("application/json").send(JSON.stringify("Jellyfin Server")),
  });
}
