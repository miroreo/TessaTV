import { describe, expect, it } from "vitest";
import { parseMediaBrowserAuthorization, readClientIdentity } from "./auth-header.js";

const SWIFTFIN_HEADER =
  'MediaBrowser Client="Swiftfin iOS", Device="iPhone", DeviceId="A1B2-C3", Version="1.0.0", Token="abc123"';

describe("parseMediaBrowserAuthorization", () => {
  it("parses quoted parameters with case-insensitive names", () => {
    const params = parseMediaBrowserAuthorization('mediabrowser client="Web", DEVICEID="x"');
    expect(Object.fromEntries(params!)).toEqual({ client: "Web", deviceid: "x" });
  });

  it("accepts the Emby scheme, unquoted values, and URL-encoded values", () => {
    const params = parseMediaBrowserAuthorization('Emby Device="Tessa%27s%20iPhone",Version=10.1');
    expect(params?.get("device")).toBe("Tessa's iPhone");
    expect(params?.get("version")).toBe("10.1");
  });

  it("ignores other schemes", () => {
    expect(parseMediaBrowserAuthorization("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseMediaBrowserAuthorization("Bearer abc")).toBeNull();
  });
});

describe("readClientIdentity", () => {
  it("reads identity and token from the Authorization header", () => {
    expect(readClientIdentity({ authorization: SWIFTFIN_HEADER })).toEqual({
      client: "Swiftfin iOS",
      device: "iPhone",
      deviceId: "A1B2-C3",
      version: "1.0.0",
      token: "abc123",
    });
  });

  it("falls back to X-Emby-Authorization", () => {
    expect(readClientIdentity({ "x-emby-authorization": SWIFTFIN_HEADER }).client).toBe("Swiftfin iOS");
  });

  it("identifies a client before login (no token yet)", () => {
    const identity = readClientIdentity({ authorization: 'MediaBrowser Client="Swiftfin", DeviceId="d"' });
    expect(identity).toMatchObject({ client: "Swiftfin", deviceId: "d", token: null });
  });

  it("accepts tokens from legacy headers and the query string, in priority order", () => {
    expect(readClientIdentity({ "x-emby-token": "header" }, { api_key: "query" }).token).toBe("header");
    expect(readClientIdentity({ "x-mediabrowser-token": "mb" }).token).toBe("mb");
    expect(readClientIdentity({}, { api_key: "q1" }).token).toBe("q1");
    expect(readClientIdentity({}, { ApiKey: "q2" }).token).toBe("q2");
  });

  it("treats empty tokens as absent", () => {
    expect(readClientIdentity({ authorization: 'MediaBrowser Token=""' }, { api_key: "q" }).token).toBe("q");
  });

  it("returns all-null for a request with no Jellyfin identity", () => {
    expect(readClientIdentity({ authorization: "Basic abc" })).toEqual({
      client: null,
      device: null,
      deviceId: null,
      version: null,
      token: null,
    });
  });
});
