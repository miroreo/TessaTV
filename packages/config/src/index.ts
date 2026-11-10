import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8096),
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters (used to derive credential encryption key)"),
  // Optional: each provider's metadata features are disabled (not absent/erroring) until
  // its key is provided.
  TMDB_API_KEY: z.string().min(1).optional(),
  TVDB_API_KEY: z.string().min(1).optional(),
  // `auto` falls back to software; an explicit `vaapi` that doesn't work fails startup.
  HARDWARE_ACCEL: z.enum(["auto", "none", "vaapi"]).default("auto"),
  VAAPI_DEVICE: z.string().min(1).optional(),
  TRANSCODE_DIR: z.string().min(1).default(join(tmpdir(), "tessatv-transcodes")),
  MAX_CONCURRENT_TRANSCODES: z.coerce.number().int().positive().default(3),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Fails fast on invalid/missing config at startup rather than limping along partially configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty value (`TMDB_API_KEY=` as in .env.example, passed through by env files) means
  // unset, so optional keys stay off and defaults apply instead of failing validation.
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(set);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
