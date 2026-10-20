import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";

/** SvelteKit adapter-node's `handler` export: a Connect-style middleware. */
export type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/**
 * adapter-node assumes `https` unless told otherwise via a configurable header, which broke
 * SSR's same-origin `fetch("/api/...")` over plain-HTTP LAN. This header is always
 * overwritten from Fastify's own view of the connection, so a client can't spoof it.
 */
const PROTOCOL_HEADER = "x-tessatv-forwarded-proto";

/**
 * Loads the built SvelteKit handler from `@tessatv/web`. The specifier is a variable on
 * purpose: the web app ships no type declarations for its build output, and tests build
 * the server without needing the web app built. Returns null when the build is missing.
 */
export async function loadWebUiHandler(specifier = "@tessatv/web/handler"): Promise<NodeRequestHandler | null> {
  // adapter-node reads its env once, at import time.
  process.env["PROTOCOL_HEADER"] ??= PROTOCOL_HEADER;
  try {
    const module = (await import(specifier)) as { handler: NodeRequestHandler };
    return module.handler;
  } catch {
    return null;
  }
}

/**
 * Serves TessaTV's own UI from the server root. Jellyfin Mobile opens the root in its web
 * view after validating `/System/Info/Public`, and the UI detects its injected
 * `window.NativeShell` hooks from there.
 *
 * Mounted as Fastify's not-found handler so every explicit route (`/api`, `/health`, the
 * Jellyfin routes) wins, and anything else falls through to SvelteKit. Because routing is
 * case-insensitive for Jellyfin's sake, UI page paths must not collide with Jellyfin's
 * route names (`/Items`, `/Users`, `/System`, …) in any casing.
 *
 * GET/HEAD only: the UI talks to `/api` with JSON, never SvelteKit form actions, and a
 * hijacked POST body would already have been consumed by Fastify's body parser.
 */
export function registerWebUiRoutes(app: FastifyInstance, handler: NodeRequestHandler): void {
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({ error: "not_found" });
    }
    reply.hijack();
    request.raw.headers[PROTOCOL_HEADER] = request.protocol;
    handler(request.raw, reply.raw, () => {
      reply.raw.statusCode = 404;
      reply.raw.end("Not found");
    });
  });
}
