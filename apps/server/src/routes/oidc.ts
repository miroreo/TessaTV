import { AuthError, type PendingOidcSignIn } from "@tessatv/auth";
import type { AuthService } from "@tessatv/auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { setSessionCookie } from "../session-token.js";
import { OIDC_CALLBACK_PATH, oidcClientConfig, type SsoDependencies } from "../sso.js";

const PENDING_COOKIE = "tessatv_oidc";
/** Long enough to type a password and do 2FA at the provider. */
const PENDING_MAX_AGE_SECONDS = 10 * 60;

/** Back to the login page with a message it shows. */
function failed(reply: FastifyReply, message: string) {
  return reply.redirect(`/login?error=${encodeURIComponent(message)}`);
}

function pendingCookieOptions(request: FastifyRequest) {
  // Lax, not strict: the provider's redirect back is a cross-site top-level navigation.
  return { path: "/api/auth/oidc", httpOnly: true, sameSite: "lax", secure: request.protocol === "https" } as const;
}

/**
 * Single sign-on through the provider in settings: `/login` sends people out, `/callback`
 * brings them back signed in. Both are full-page redirects, not API calls.
 */
export function registerOidcRoutes(app: FastifyInstance, auth: AuthService, sso: SsoDependencies): void {
  app.get("/api/auth/oidc/login", async (request, reply) => {
    const config = oidcClientConfig((await sso.settings.get()).oidc, sso.clientSecrets);
    if (!config) return failed(reply, "Single sign-on isn't set up");
    try {
      const { url, pending } = await sso.client.start(config);
      reply.setCookie(PENDING_COOKIE, sso.pendingSignIns.seal(JSON.stringify(pending)), {
        ...pendingCookieOptions(request),
        maxAge: PENDING_MAX_AGE_SECONDS,
      });
      return reply.redirect(url.href);
    } catch (error) {
      request.log.warn({ error: (error as Error).message }, "couldn't reach the SSO provider");
      return failed(reply, "Couldn't reach the sign-in provider. Try again, or sign in with a password.");
    }
  });

  app.get(OIDC_CALLBACK_PATH, async (request, reply) => {
    const oidc = (await sso.settings.get()).oidc;
    const config = oidcClientConfig(oidc, sso.clientSecrets);
    const sealed = request.cookies[PENDING_COOKIE];
    reply.clearCookie(PENDING_COOKIE, pendingCookieOptions(request));
    if (!config || !oidc) return failed(reply, "Single sign-on isn't set up");
    const opened = sealed ? sso.pendingSignIns.open(sealed) : null;
    if (!opened) return failed(reply, "That sign-in took too long or came from another browser. Please try again.");

    const query = new URL(request.url, "http://localhost").searchParams;
    const providerError = query.get("error_description") ?? query.get("error");
    if (providerError) return failed(reply, `The sign-in provider said: ${providerError}`);

    try {
      // Rebuilt on the configured address: behind a proxy, the request's own host is the proxy's view.
      const callbackUrl = new URL(`${OIDC_CALLBACK_PATH}?${query}`, oidc.publicUrl);
      const identity = await sso.client.finish(config, callbackUrl, JSON.parse(opened) as PendingOidcSignIn);
      const result = await auth.signInWithOidc(
        identity,
        { adminGroup: oidc.adminGroup, requiredGroup: oidc.requiredGroup },
        request.headers["user-agent"]?.slice(0, 200) ?? null,
      );
      if (result.created) await sso.onAccountCreated?.(result.user);
      setSessionCookie(request, reply, result.token);
      return reply.redirect("/");
    } catch (error) {
      if (error instanceof AuthError) return failed(reply, error.message);
      request.log.warn({ error: (error as Error).message }, "SSO sign-in failed");
      return failed(reply, "Sign-in failed. Try again, or sign in with a password.");
    }
  });
}
