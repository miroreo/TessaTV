import type { FastifyInstance } from "fastify";
import { registerSystemRoutes } from "./routes/system.js";
import { JELLYFIN_API_VERSION, type JellyfinServerInfo } from "./server-info.js";

export interface JellyfinCompatOptions {
  /** Stable 32-hex server id — use `deriveServerId(APP_SECRET)`. */
  readonly serverId: string;
  readonly serverName: string;
}

/**
 * Mounts the Jellyfin-compatible API at the server root (Jellyfin clients don't support a
 * path prefix for most routes). Jellyfin's routes are case-insensitive and clients rely on
 * that, so the host Fastify instance must be created with
 * `routerOptions: { caseSensitive: false }` — a router-wide setting a plugin can't change.
 */
export function registerJellyfinCompat(app: FastifyInstance, options: JellyfinCompatOptions): void {
  const server: JellyfinServerInfo = {
    id: options.serverId,
    name: options.serverName,
    version: JELLYFIN_API_VERSION,
  };
  registerSystemRoutes(app, server);
}
