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
  // Subtitle downloads are off until all three OpenSubtitles.com values are set (the key is the
  // app consumer key from the account's API page; downloads also need the account's login).
  OPENSUBTITLES_API_KEY: z.string().min(1).optional(),
  OPENSUBTITLES_USERNAME: z.string().min(1).optional(),
  OPENSUBTITLES_PASSWORD: z.string().min(1).optional(),
  // Comma-separated, most wanted first, e.g. `en,pt-BR`. Add `.forced` to a language for its forced track too.
  SUBTITLE_LANGUAGES: z.string().min(1).default("en"),
  // Whether to prefer subtitles for the deaf and hard of hearing (SDH), avoid them, or not care.
  SUBTITLE_HEARING_IMPAIRED: z.enum(["prefer", "avoid", "any"]).default("avoid"),
  // `auto` falls back to software; an explicit `vaapi` that doesn't work fails startup.
  HARDWARE_ACCEL: z.enum(["auto", "none", "vaapi"]).default("auto"),
  VAAPI_DEVICE: z.string().min(1).optional(),
  TRANSCODE_DIR: z.string().min(1).default(join(tmpdir(), "tessatv-transcodes")),
  MAX_CONCURRENT_TRANSCODES: z.coerce.number().int().positive().default(3),
}).refine(
  (env) => [env.OPENSUBTITLES_API_KEY, env.OPENSUBTITLES_USERNAME, env.OPENSUBTITLES_PASSWORD].filter(Boolean).length % 3 === 0,
  { message: "OPENSUBTITLES_API_KEY, OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD must be set together", path: ["OPENSUBTITLES_API_KEY"] },
);

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
