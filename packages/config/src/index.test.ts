import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const validEnv = {
  DATABASE_URL: "postgres://tessatv:tessatv@localhost:5432/tessatv",
  PORT: "8096",
  APP_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const config = loadConfig(validEnv);
    expect(config).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
      PORT: 8096,
      APP_SECRET: validEnv.APP_SECRET,
    });
  });

  it("defaults PORT when not provided", () => {
    const config = loadConfig({ DATABASE_URL: validEnv.DATABASE_URL, APP_SECRET: validEnv.APP_SECRET });
    expect(config.PORT).toBe(8096);
  });

  it("fails fast on a missing DATABASE_URL instead of starting partially configured", () => {
    expect(() => loadConfig({ PORT: validEnv.PORT, APP_SECRET: validEnv.APP_SECRET })).toThrow(/DATABASE_URL/);
  });

  it("fails fast on an APP_SECRET that is too short to derive an encryption key from", () => {
    expect(() => loadConfig({ ...validEnv, APP_SECRET: "too-short" })).toThrow(/APP_SECRET/);
  });

  it("TMDB_API_KEY and TVDB_API_KEY are optional, independently — each provider stays off rather than blocking startup", () => {
    expect(loadConfig(validEnv).TMDB_API_KEY).toBeUndefined();
    expect(loadConfig(validEnv).TVDB_API_KEY).toBeUndefined();
    expect(loadConfig({ ...validEnv, TMDB_API_KEY: "a-real-key" }).TMDB_API_KEY).toBe("a-real-key");
    expect(loadConfig({ ...validEnv, TVDB_API_KEY: "a-real-key" }).TVDB_API_KEY).toBe("a-real-key");
  });
});
