/**
 * Who a Jellyfin client says it is, and the access token it presented (if any). Jellyfin
 * clients identify themselves on every request — before login too — so this is parsed
 * independently of whether the token turns out to be valid.
 */
export interface JellyfinClientIdentity {
  readonly client: string | null;
  readonly device: string | null;
  readonly deviceId: string | null;
  readonly version: string | null;
  readonly token: string | null;
}

const AUTH_SCHEMES = new Set(["mediabrowser", "emby"]);

type HeaderValue = string | string[] | undefined;

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses `MediaBrowser Client="Swiftfin", Device="iPhone", DeviceId="…", Version="1.0",
 * Token="…"` (scheme `Emby` is also accepted). Parameter names are case-insensitive and
 * values may be URL-encoded, matching Jellyfin's own parser. Returns null for any other
 * scheme (e.g. `Basic`), so a non-Jellyfin `Authorization` header is ignored, not misread.
 */
export function parseMediaBrowserAuthorization(value: string): Map<string, string> | null {
  const trimmed = value.trim();
  const space = trimmed.indexOf(" ");
  const scheme = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  if (!AUTH_SCHEMES.has(scheme)) return null;

  const params = new Map<string, string>();
  const pattern = /([A-Za-z]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g;
  for (const match of trimmed.slice(space + 1).matchAll(pattern)) {
    const key = match[1]!.toLowerCase();
    const raw = match[2] ?? match[3] ?? "";
    params.set(key, decode(raw));
  }
  return params;
}

/**
 * Collects a client's identity from every place Jellyfin accepts it: the `Authorization`
 * or `X-Emby-Authorization` header, the legacy `X-Emby-Token`/`X-MediaBrowser-Token`
 * headers, and the `api_key`/`ApiKey` query parameter (used by clients for image and
 * stream URLs, where they can't set headers). The first token found wins, in that order.
 */
export function readClientIdentity(
  headers: Record<string, HeaderValue>,
  query: Record<string, unknown> = {},
): JellyfinClientIdentity {
  const params =
    [firstHeader(headers["authorization"]), firstHeader(headers["x-emby-authorization"])]
      .filter((value): value is string => value !== undefined)
      .map(parseMediaBrowserAuthorization)
      .find((parsed) => parsed !== null) ?? new Map<string, string>();

  const nonEmpty = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const token =
    nonEmpty(params.get("token")) ??
    nonEmpty(firstHeader(headers["x-emby-token"])) ??
    nonEmpty(firstHeader(headers["x-mediabrowser-token"])) ??
    nonEmpty(query["api_key"]) ??
    nonEmpty(query["ApiKey"]) ??
    nonEmpty(query["apikey"]);

  return {
    client: nonEmpty(params.get("client")),
    device: nonEmpty(params.get("device")),
    deviceId: nonEmpty(params.get("deviceid")),
    version: nonEmpty(params.get("version")),
    token,
  };
}
