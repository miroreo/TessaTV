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
    expect(config).toMatchObject({
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

  it("treats empty values as unset, as env files write them (`TMDB_API_KEY=`)", () => {
    const config = loadConfig({ ...validEnv, TMDB_API_KEY: "", TVDB_API_KEY: "", PORT: "", HARDWARE_ACCEL: "" });
    expect(config.TMDB_API_KEY).toBeUndefined();
    expect(config.TVDB_API_KEY).toBeUndefined();
    expect(config.PORT).toBe(8096);
    expect(config.HARDWARE_ACCEL).toBe("auto");
    expect(() => loadConfig({ ...validEnv, APP_SECRET: "" })).toThrow(/APP_SECRET/);
  });

  it("keeps memory diagnostics off unless a directory is given, capturing at 1 GB by default", () => {
    expect(loadConfig(validEnv).DIAGNOSTICS_DIR).toBeUndefined();
    expect(loadConfig(validEnv).DIAGNOSTICS_CAPTURE_AT_MB).toBe(1024);
    const on = loadConfig({ ...validEnv, DIAGNOSTICS_DIR: "/diag", DIAGNOSTICS_CAPTURE_AT_MB: "512" });
    expect(on).toMatchObject({ DIAGNOSTICS_DIR: "/diag", DIAGNOSTICS_CAPTURE_AT_MB: 512 });
    expect(loadConfig({ ...validEnv, DIAGNOSTICS_DIR: "" }).DIAGNOSTICS_DIR).toBeUndefined();
    expect(() => loadConfig({ ...validEnv, DIAGNOSTICS_CAPTURE_AT_MB: "0" })).toThrow(/DIAGNOSTICS_CAPTURE_AT_MB/);
  });

  it("defaults transcoding settings, and rejects an unknown hardware accel mode", () => {
    expect(loadConfig(validEnv)).toMatchObject({ HARDWARE_ACCEL: "auto", MAX_CONCURRENT_TRANSCODES: 3, VAAPI_HARDWARE_DECODE: false });
    expect(loadConfig({ ...validEnv, VAAPI_HARDWARE_DECODE: "true" }).VAAPI_HARDWARE_DECODE).toBe(true);
    expect(loadConfig(validEnv).TRANSCODE_DIR).toMatch(/tessatv-transcodes$/);
    expect(() => loadConfig({ ...validEnv, HARDWARE_ACCEL: "nvenc" })).toThrow(/HARDWARE_ACCEL/);
  });
});
