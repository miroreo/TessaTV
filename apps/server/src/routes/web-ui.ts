import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** SvelteKit adapter-node's `handler` export: a Connect-style middleware. */
export type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export const WEB_UI_BASE_PATH = "/web";

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
 * Mounts TessaTV's own UI under `/web` and redirects `/` there. Jellyfin Mobile opens the
 * server root in its web view after validating `/System/Info/Public`, so the root has to
 * land on a real UI — the same `/` → `/web` layout real Jellyfin servers use.
 *
 * GET/HEAD only: the UI talks to `/api` with JSON, never SvelteKit form actions, and a
 * hijacked POST body would already have been consumed by Fastify's body parser.
 */
export function registerWebUiRoutes(app: FastifyInstance, handler: NodeRequestHandler): void {
  app.get("/", async (_request, reply) => reply.redirect(`${WEB_UI_BASE_PATH}/`));

  const serve = (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    request.raw.headers[PROTOCOL_HEADER] = request.protocol;
    handler(request.raw, reply.raw, () => {
      reply.raw.statusCode = 404;
      reply.raw.end("Not found");
    });
  };
  app.get(WEB_UI_BASE_PATH, serve);
  app.get(`${WEB_UI_BASE_PATH}/*`, serve);
}
