import { AuthError, type AuthErrorCode, type AuthService } from "@tessatv/auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "../session-token.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the `/api` auth hook on every authenticated request. */
    user?: { id: string; username: string; isAdmin: boolean };
  }
}

/** `/api` routes reachable without a session: enough to run first-run setup and log in. */
const PUBLIC_API_ROUTES = new Set(["/api/auth/session", "/api/auth/setup", "/api/auth/login", "/api/auth/logout"]);

const ERROR_STATUS: Record<AuthErrorCode, number> = {
  setup_already_completed: 409,
  invalid_username: 400,
  weak_password: 400,
  invalid_credentials: 401,
};

interface Credentials {
  username?: unknown;
  password?: unknown;
}

function clientName(request: FastifyRequest): string | null {
  return request.headers["user-agent"]?.slice(0, 200) ?? null;
}

function credentials(body: Credentials | undefined): { username: string; password: string } | null {
  if (typeof body?.username !== "string" || typeof body.password !== "string") return null;
  return { username: body.username, password: body.password };
}

async function sendAuthError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AuthError)) throw error;
  return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  // Locks down every /api route except the public ones above. Route-level config would be
  // easy to forget on a new route; deny-by-default can't be.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!.toLowerCase();
    if (!path.startsWith("/api/") || PUBLIC_API_ROUTES.has(path)) return;
    const token = readSessionToken(request);
    const authenticated = token ? await auth.authenticate(token) : null;
    if (!authenticated) return reply.code(401).send({ error: "unauthorized" });
    request.user = authenticated.user;
  });

  /** Everything the UI needs to decide between the setup page, login page, and the app. */
  app.get("/api/auth/session", async (request) => {
    const token = readSessionToken(request);
    const authenticated = token ? await auth.authenticate(token) : null;
    return { needsSetup: await auth.needsSetup(), user: authenticated?.user ?? null };
  });

  app.post<{ Body: Credentials }>("/api/auth/setup", async (request, reply) => {
    const input = credentials(request.body);
    if (!input) return reply.code(400).send({ error: "invalid_request" });
    try {
      const result = await auth.completeSetup(input.username, input.password, clientName(request));
      setSessionCookie(request, reply, result.token);
      return { user: result.user, token: result.token };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post<{ Body: Credentials }>("/api/auth/login", async (request, reply) => {
    const input = credentials(request.body);
    if (!input) return reply.code(400).send({ error: "invalid_request" });
    try {
      const result = await auth.login(input.username, input.password, clientName(request));
      setSessionCookie(request, reply, result.token);
      return { user: result.user, token: result.token };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = readSessionToken(request);
    if (token) await auth.logout(token);
    clearSessionCookie(request, reply);
    return reply.code(204).send();
  });
}
