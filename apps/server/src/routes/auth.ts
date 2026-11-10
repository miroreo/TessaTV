import { AuthError, type AuthErrorCode, type AuthService } from "@tessatv/auth";
import type { LoginResponse, PublicUser, SessionResponse } from "@tessatv/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "../session-token.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the `/api` auth hook on every authenticated request. */
    user?: PublicUser;
  }
}

/** `/api` routes reachable without a session: enough to run first-run setup and log in. */
const PUBLIC_API_ROUTES = new Set([
  "/api/auth/session",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
]);

const ERROR_STATUS: Record<AuthErrorCode, number> = {
  setup_already_completed: 409,
  invalid_username: 400,
  weak_password: 400,
  invalid_credentials: 401,
  not_in_required_group: 403,
  username_taken: 409,
};

const credentialsSchema = { body: z.object({ username: z.string(), password: z.string() }) };

function clientName(request: FastifyRequest): string | null {
  return request.headers["user-agent"]?.slice(0, 200) ?? null;
}

async function sendAuthError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AuthError)) throw error;
  return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
}

/**
 * `ssoButtonLabel` resolves to the login page's SSO button text, or null when single
 * sign-on is off.
 */
export function registerAuthRoutes(
  server: FastifyInstance,
  auth: AuthService,
  ssoButtonLabel: () => Promise<string | null> = async () => null,
): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

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
  app.get("/api/auth/session", async (request): Promise<SessionResponse> => {
    const token = readSessionToken(request);
    const authenticated = token ? await auth.authenticate(token) : null;
    const buttonLabel = await ssoButtonLabel();
    return { needsSetup: await auth.needsSetup(), user: authenticated?.user ?? null, sso: buttonLabel ? { buttonLabel } : null };
  });

  app.post("/api/auth/setup", { schema: credentialsSchema }, async (request, reply) => {
    try {
      const { username, password } = request.body;
      const result = await auth.completeSetup(username, password, clientName(request));
      setSessionCookie(request, reply, result.token);
      return { user: result.user, token: result.token } satisfies LoginResponse;
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/login", { schema: credentialsSchema }, async (request, reply) => {
    try {
      const { username, password } = request.body;
      const result = await auth.login(username, password, clientName(request));
      setSessionCookie(request, reply, result.token);
      return { user: result.user, token: result.token } satisfies LoginResponse;
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
