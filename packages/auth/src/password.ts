import { hash, verify } from "@node-rs/argon2";
import { scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Argon2id with @node-rs/argon2's defaults (19 MiB, t=2, p=1 — OWASP's recommended
 * minimum). The parameters are encoded in each PHC-format hash, so they can be raised
 * later; `needsRehash` then flags old hashes for an upgrade on next login.
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize("NFKC"));
}

/** True for a hash that should be replaced with a fresh `hashPassword` result. */
export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith("$argon2id$");
}

/** Constant-time comparison. Returns false (never throws) for a malformed stored hash. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const normalized = password.normalize("NFKC");
  if (storedHash.startsWith("scrypt$")) return verifyLegacyScrypt(normalized, storedHash);
  try {
    return await verify(storedHash, normalized);
  } catch {
    return false;
  }
}

/**
 * Hashes from before the switch to Argon2 (`scrypt$N$r$p$<salt>$<key>`). Verified only so
 * existing accounts can still log in, after which they're rehashed. Remove once no
 * `scrypt$` hashes remain in `app_user`.
 */
async function verifyLegacyScrypt(password: string, storedHash: string): Promise<boolean> {
  const [, N, r, p, salt, key] = storedHash.split("$");
  if (!N || !r || !p || !salt || !key) return false;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  const expected = Buffer.from(key, "base64");
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r };
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, "base64"), expected.length, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
