import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Jellyfin serializes ids as 32 lowercase hex characters with no dashes. */
export function toJellyfinId(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

/**
 * Accepts either Jellyfin's dashless form or a dashed UUID (clients send both, depending on
 * where the id came from) and returns the dashed form TessaTV stores. Null for anything
 * that isn't a UUID, so callers can 404 instead of passing garbage to Postgres.
 */
export function fromJellyfinId(id: string): string | null {
  if (!UUID_PATTERN.test(id)) return null;
  const hex = id.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable server id without a schema change: clients key saved servers by this, so it must
 * survive restarts. Derived one-way from APP_SECRET so it never reveals the secret.
 */
export function deriveServerId(appSecret: string): string {
  return createHash("sha256").update(`tessatv:jellyfin-server-id:${appSecret}`).digest("hex").slice(0, 32);
}
