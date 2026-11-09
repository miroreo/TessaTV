import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "tessatv_session";
/** Browsers cap cookie lifetime at 400 days; the session itself lasts until logout. */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * The browser UI authenticates with an HttpOnly cookie (so page scripts never hold the
 * token); other clients send `Authorization: Bearer <token>`.
 */
export function readSessionToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token) return token;
  }
  return request.cookies[SESSION_COOKIE] ?? null;
}

function cookieOptions(request: FastifyRequest) {
  // `Secure` only over HTTPS: the LAN/Tailscale dev setup is plain HTTP, where a Secure
  // cookie would never be sent back.
  return { path: "/", httpOnly: true, sameSite: "lax", secure: request.protocol === "https" } as const;
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions(request), maxAge: COOKIE_MAX_AGE_SECONDS });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(request));
}
