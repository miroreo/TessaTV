import { createHash, randomBytes } from "node:crypto";

/** 256 bits of randomness, URL-safe so it can travel in a query string (`api_key=`). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Tokens are full-entropy random values, so a fast unsalted hash is enough to make a
 * leaked session table useless (unlike passwords, there's nothing to brute-force).
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
