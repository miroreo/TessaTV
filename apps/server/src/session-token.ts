import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "tessatv_session";
/** Browsers cap cookie lifetime at 400 days; the session itself lasts until logout. */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

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
  return readCookie(request.headers.cookie, SESSION_COOKIE);
}

function cookieAttributes(request: FastifyRequest, maxAge: number): string {
  // `Secure` only over HTTPS: the LAN/Tailscale dev setup is plain HTTP, where a Secure
  // cookie would never be sent back.
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${request.protocol === "https" ? "; Secure" : ""}`;
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(request, COOKIE_MAX_AGE_SECONDS)}`);
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=; ${cookieAttributes(request, 0)}`);
}
